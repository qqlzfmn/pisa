# 017 · 触发器幂等与线程归属

- 状态：implemented
- 关联：006/007（GitHub 评论与 Issue 派活）、009（定时投递）、004（主动发现）

## 1. 问题

去重只有事件号一个维度：`events` 表按 `event_id` 占位（`store.claimEvent`），任务表的 `source` 就是那个事件号。事件号由各入口自造，于是：

- **编辑被静默丢弃**。Telegram 事件号是 `telegram:<chatId>:<messageId>`，编辑消息后消息 id 不变，第二次投递被 `claimEvent` 判为重复直接 `return`：新正文既没进任务，也没留下任何痕迹。复现：同一会话先发 `/pisa 修登录`、再编辑成 `/pisa 修登录并补测试`，库里仍只有 1 个任务，`prompt` 是旧正文。
- **跨入口拆单**。同一件事从 GitHub 评论（`github:comment:<repo>:<id>`）与 webhook（`webhook:<ts>:<rand>`）各来一次就是两个事件号，各建一个任务，跑两遍。
- **任务不知道自己在哪个会话**。`tasks` 没有线程、版本、载荷指纹，无法回答「这个任务属于哪个会话」「这条消息改过几次」，回复续跑只能绑定在 bot 发出的消息 id 上。
- **事件号跨通道串用**。`events` 以 `event_id` 为主键，`webhook:` / `cron:` / `github:comment:` / `telegram:` 挤在同一张表。webhook 接受调用方自带的任意 `eventId`（`src/index.ts`），持有 token 的一方可以先占 `cron:<job>:<minute>` 或 `github:comment:<repo>:<id>`；占位若排在鉴权之前，被拒的投递还会静默吃掉后来者的 `eventId`。webhook 的 token 用 `!==` 比较，请求体也没有上限。

证据：`src/router.ts` 建任务前 `store.claimEvent(msg.eventId, taskId)`；`src/store.ts` 的 `events(event_id PK)` 与 `taskByEvent`；`src/github-watcher.ts` 注释「去重靠投递时的稳定 eventId … 由 Router 的 claimEvent 落库」。

## 2. 目标

- 触发器有独立、可审计的身份：来源、线程、消息、版本、载荷指纹
- 同一触发器只对应一个任务；重复投递返回已有任务
- 同一条消息的新版本（编辑）归到原任务，不新建；原任务还没开跑时正文更新为最新版本
- 同一 thread 的后续消息在库里归属到该 thread
- 旧库升级后任务与去重能力都不丢

## 3. 用户故事

### US-1 重试投递的脚本

我写的 CI 脚本超时重试，同一事件投两次；第二次返回第一次的任务号，不会有两个任务抢同一个分支。

### US-2 改了主意的用户

消息发出去才发现要补一句；编辑后任务用的是新正文，不需要撤回再发一遍。

### US-3 多入口运维

同一件事既有 GitHub 评论又有 webhook 投递；两边声明同一个线程与事件身份时，只建一个任务。

### US-4 排查的人

从任务号能查到触发它的来源、会话、版本与载荷指纹，判断是重复投递还是不同需求。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `triggers` 表记录 `id`、`source`、`thread_key`、`message_key`、`actor`、`at`、`payload_hash`、`version`、`kind`、`task_id` |
| FR-002 | 触发器与任务同一事务落库；同一线程同一消息的重复投递只建一个任务 |
| FR-003 | 同一线程同一消息的不同版本视为编辑：挂到原任务，不建新任务；原任务仍在排队时正文更新为新版本。已登记过的版本再次投递不再留痕、不改写任务；比当前最大版本旧的未登记版本只留痕，正文保持最新版本 |
| FR-004 | 编辑按 `version` 在 `triggers` 里留独立行（`kind=context`），与建任务那行可区分；版本先后按数值（Telegram 秒级时间戳）或字典序（GitHub ISO 时间）比较，空版本不参与排序 |
| FR-005 | 入口可显式声明线程与版本（IM 论坛话题、GitHub 评论 `updated_at`、webhook `threadKey`/`version`）；未声明时线程按「回复的任务 > 该消息自身」推导 |
| FR-006 | 旧库启动时按任务既有字段补触发器，不改动 `tasks` 行 |
| FR-007 | 对外行为不变：webhook 响应、CLI 回执、Web 控制台都能拿回既有任务号；`pisa --event-id` 重复调用返回原任务 |
| FR-008 | 同一线程里的不同消息仍各建任务（显式新需求），只在触发器里共用 `thread_key` |
| FR-009 | 入口可以把触发者（`actor`）与需求方（`requester`）分开声明，GitHub 评论按评论作者记 `actor` |
| FR-010 | 同一线程里不带命令的后续消息并进该线程未结束任务（`queued`/`paused`）的上下文，不建任务；重复投递同一句不重复追加 |
| FR-011 | `events` 是按 `event_id` 主键的跨通道共享表，命名空间即权限边界：webhook 只接受 `webhook:` 开头的 `eventId`，其它前缀返回 400；省略时自动生成 `webhook:<ts>:<rand>` |
| FR-012 | 事件占位排在鉴权与正文校验之后、任务落库之前；被拒的投递不写 `events`，同 `eventId` 的合法投递不受影响。去重仍由 `triggers` 决定，占位结果不拦截建任务（同 `eventId` 的编辑要继续进入触发器路径） |
| FR-013 | webhook 的 token 用常量时间比较（长度不等直接 403），正文上限 64 KiB，超过返回 413 |

## 5. 验收

| 场景 | 预期 |
| --- | --- |
| 同一消息投递两次 | 1 个任务，`triggers` 1 行 |
| 同一消息声明两个线程 | 2 个任务 |
| 同一消息 v1 → v2 | 1 个任务，`triggers` 2 行（`kind=task`/`context`），排队任务的 `prompt` 为 v2 |
| v1 → v2 之后重投 v1 | 1 个任务，`triggers` 仍 2 行，`prompt` 保持 v2，无回执 |
| v1 → v3 之后到达未登记的 v2 | `triggers` 3 行，`prompt` 保持 v3，回执说明旧版本只做了留痕 |
| 已开跑任务被编辑 | 任务正文不变，编辑仍留 `kind=context` 行 |
| 旧库打开 | 任务行数不变，每个任务有触发器；重放旧事件不建新任务 |
| 回复某条任务消息续跑 | 子任务触发器 `thread_key` 为 `task:<父任务号>` |
| 同线程再发一句不带命令的话 | 仍是 1 个任务，任务 `context` 追加一条「补充说明：…」，触发器多一行 `kind=context` |
| 非白名单用户投递 `eventId=E` 被拒后再以白名单身份投递同一 `E` | 任务成立并回「已接单」；`events` 里 `E` 只对应这一个任务 |
| webhook 投递 `eventId=cron:morning:2026-11-18T09:00` | 400，`events` 无该键，不建任务 |
| webhook 省略 `eventId` | 自动生成 `webhook:<ts>:<rand>`，回执里带回 |
| 伪造 `Content-Length` 超过 64 KiB | 413，不读正文、不建任务 |

## 6. 非目标

- 不做跨仓库、跨需求的内容去重（同线程不同消息仍是两个任务）
- 不自动合并同一线程里并发的多条新需求
- 不改任务状态机与 Worker 契约
