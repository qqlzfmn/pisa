# 017 · 实施计划

## 1. 结构

一次投递的身份拆成四段，全部由入口能稳定给出的值构成：

| 段 | 取值 | 作用 |
| --- | --- | --- |
| `source` | 入口名（telegram / github / cli / web / webhook / cron） | 区分事件来源 |
| `thread_key` | 入口显式声明 > `task:<回复的任务号>` > `<channel>:<chatId>:<eventId>` | 会话归属，同线程消息共用 |
| `message_key` | `messageKey` ?? `eventId` | 同一条消息的多个版本共用一个消息键 |
| `version` | IM 编辑时间、GitHub `updated_at`，缺省空串 | 同一消息的版本区分 |

`payload_hash` 是规范化正文（CRLF→LF、去首尾空白）的 SHA-256；`id` 是五段串接后的摘要。正文用**解析后的需求**（`prompt`）而不是原始消息：`/pisa 修登录` 与 webhook 直接投 `修登录` 是同一件事，包装差异不该造出两条身份。

## 2. 关键取舍

| 决策 | 备选 | 理由 |
| --- | --- | --- |
| 新增 `triggers` 表，`events` 保留 | 改造 `events` 加列 | `events` 还承担 cron 抢跑、保留清理的占位，语义是「一次性标记」；触发器是「事件身份 + 任务归属」，混在一张表会让占位行也有 task 语义 |
| 同一 `(thread_key, message_key)` 只认一个任务 | 只按 `id` 去重 | 编辑后 `id` 必然变（版本/载荷都变），只按 `id` 去重等于没解决编辑丢正文；按消息去重才能把编辑挂回原任务 |
| 编辑只在 `queued` 时改 `prompt` | 一律改 `prompt`；一律写 `context` | 任务开跑后正文已被 Worker 使用，改库只会让数据库与执行记录不一致；写 `context` 对已开跑任务也不会被再次读取，属于假装生效 |
| 旧库在 `Store` 构造时补齐触发器 | 独立迁移命令 | 触发器只是 `tasks` 的派生索引，构造时幂等补齐，升级不需要人工步骤 |
| CLI/Web 复用触发器 API | 各自保留 `events` 去重 | 两套去重机制并存就是架构分叉；CLI `--event-id` 语义用「同消息不建第二个任务」原样表达 |
| 不做触发器清理 | 跟 `events` 一起过期 | 任务行本身不删，触发器行数与任务同阶；清了触发器等于忘了哪些事件处理过，重放会重复建任务 |

## 3. 数据模型

`triggers`：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | 身份摘要（sha256 前 32 位十六进制） |
| `source` / `thread_key` / `message_key` | TEXT NOT NULL | 见上表，索引 `(thread_key, message_key)` |
| `actor` | TEXT NOT NULL | 触发者；GitHub 为评论作者，IM 为用户 id |
| `at` | INTEGER NOT NULL | 入口给的接收时间，缺省为建任务时刻 |
| `payload_hash` | TEXT NOT NULL | 正文指纹 |
| `version` | TEXT NOT NULL | 版本，缺省空串 |
| `kind` | TEXT NOT NULL | `task`（建了任务）/ `context`（编辑或补充，挂到已有任务） |
| `task_id` | TEXT | 指向任务 |

## 4. 改动面

- `src/trigger.ts`（新）：`makeTrigger`、`threadKeyOf`、`payloadHash`
- `src/types.ts`：`IncomingMessage` 增加 `threadKey` / `messageKey` / `version` / `actor`
- `src/store.ts`：`triggers` 表与索引、`triggerByMessage`、`createTaskFromTrigger`（重复投递 / 编辑判定同事务）、`attachThreadNote`、`updatePrompt`、`openTaskByThread`、旧库补齐；删除 `taskByEvent`、`insertTaskOnce`
- `src/router.ts`：解析线程、触发器去重、编辑挂载、同线程无命令消息并进上下文；`claimEvent` 退出建任务路径
- `src/cli.ts`、`src/web.ts`：改走触发器 API
- `src/channels/telegram.ts`：`edited_message` 与论坛话题线程、版本、actor
- `src/github-watcher.ts`、`src/github.ts`：评论 `updated_at` 作为版本，线程为 `github:<repo>:issue:<n>`，actor 为评论作者
- `src/index.ts`：webhook 接受 `threadKey` / `version`
- `docs/architecture.md`、`CHANGELOG.md`、`docs/operations.md`：触发源契约与 webhook 字段

## 5. 测试策略

- `tests/trigger-thread.test.ts`：重复投递 1 个任务、两个线程 2 个任务、v1→v2 编辑挂回原任务并更新排队正文、已开跑任务编辑只留痕、旧库补齐并重放不建新任务、回复续跑线程为 `task:<父>`、CLI `--event-id` 幂等、GitHub 评论编辑不新建任务
- 既有 `tests/router.test.ts`、`tests/github-comments.test.ts`、`tests/cli.test.ts`、`tests/retention.test.ts` 必须继续通过

## 6. 风险

- **README/文档里的「eventId 稳定」说法过期**：`docs/architecture.md` 4.2 表按新契约改写
- **webhook 调用方按旧字段理解**：`eventId` 行为不变（仍是幂等键），新增字段全部可选
- **论坛话题把整段聊天并进一个线程**：只影响 `thread_key` 归属，任务的建与不建仍按消息判断
