# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。本文件从 `0.1.0` 起记录；版本号以 `package.json` 为准。

## [Unreleased]

### 新增

- 提示词分层与版本：Worker 提示词拆成五个段落（任务号、恢复执行、上一轮上下文、任务正文、约束），`prompts/` 目录可按段落覆盖——团队层 `prompts/<键>.md`，仓库层 `prompts/repos/<别名>/<键>.md`，优先级仓库 > 团队 > 内置；`prompts/VERSION` 记录覆盖版本。启动时加载，未知段落键、未知仓库别名、空文件、非法版本号、未知模板变量都拒绝启动。`/pisa prompts` 查看版本与每段来源，`/pisa prompts diff [@仓库]` 查看与内置的差异；`worker.constraints` 支持按仓库定制评审标准（`src/prompts.ts`，配置项 `promptsDir`）
- 健康与任务指标：`GET /health` 返回 `ok`、`uptimeSec`、队列深度、running 数与最近 24h 成功率/耗时分位/每仓库任务数；`ok` 取守护进程心跳，心跳停止时返回 503。看板与 `pisa status --json` 附带同一口径的 24h 汇总（`src/metrics.ts`）
- `triggers` 表：任务创建改为按触发身份（`source` + 线程 + 消息 + 版本 + 载荷指纹）落库，触发器与任务同一事务；旧库在 `Store` 构造时按任务自身信息补齐，重放旧事件不会重复建单
- 编辑与线程归属：同一消息的新版本按 `version` 留痕，任务仍在排队就更新需求正文；同线程不带命令的后续消息并进未结束任务的上下文
- 入口身份字段：`IncomingMessage` 新增 `threadKey` / `messageKey` / `version` / `actor`；Telegram 处理 `edited_message` 与论坛话题线程，GitHub 评论用 `updated_at` 作版本、评论作者作 actor，webhook 接受 `threadKey` / `version`

### 修复

- webhook 事件号越界占用：`eventId` 必须以 `webhook:` 开头，`cron:` / `github:comment:` / `telegram:` 等通道命名空间返回 400，避免持有 webhook token 的一方先占定时任务与评论派活的键；token 改常量时间比较（长度不等 403），正文上限 64 KiB（413）
- 被拒的投递不再占事件号：事件占位排在鉴权与正文校验之后、任务落库之前，非白名单用户投递同一个 `eventId` 不会让随后的合法投递被静默丢弃
- 恢复中断任务不再重放旧过程消息：`resume` 从进度文件已写位置继续轮询，上一轮推送过的工具调用不会在重启后重复出现
- 重启恢复尊重 `cancel_requested`：执行中说 `cancel` 的任务遇进程重启直接落 `cancelled`，不会再变成 `paused` 被后续 `resume` 复活；启动日志与恢复表同步三类计数

### 变更

- 交付提交按路径拦截敏感文件：`.github/workflows/**`、`.github/actions/**`、`.env*`、`*.pem`、`*.key`、`id_*`、`.npmrc`、`.netrc`、`**/secrets*` 用 `git reset` 剔出索引，回执列出未提交路径；全部被拦时不产生空提交
- 推送、建 PR、回帖改为经 outbox 执行：失败不再只记日志，退避到期后自动补发；建 PR 失败仍退回 `compare` 链接，任务终态不变
- README 从配置说明改为产品首页：一句话定位、三类读者路径、30 秒上手、架构图与分层表、三个带预期输出的场景、与 CNB NPC / Copilot cloud agent 的边界对比、FAQ、已知限制、演示 GIF（`docs/assets/demo.gif`）
- 配置与运维细节（全部配置项、IM/CLI 命令、webhook、多仓库、GitHub 评论、定时、保留、launchd）迁到 [docs/operations.md](./docs/operations.md)，README 只保留入口

### 新增

- Outbox（`src/effects.ts` + `effects` 表）：外部动作先落库再执行，同一 `(kind,key)` 只执行一次，失败按 2s→60s 指数退避（最多 10 次），进程重启后继续重放；推送与建 PR 在仓库根目录执行，工作副本删掉后重试仍可用
- `LICENSE`（MIT），徽章与 GitHub 仓库许可字段据此生效
- `tests/docs-links.test.ts`：所有 Markdown 的相对链接必须有落点，README 的页内锚点必须落在真实标题上

## [0.1.0] - 2026-11-18

### 新增

- Router + Worker：一个入口收消息，按仓库分派到隔离 worktree 执行，结果回到原会话
- 多 Worker 并行，`worker.concurrency` 控制上限（默认 2），任务级隔离
- 通道：Telegram（私聊直说、群聊需触发词）、本地 CLI、webhook `POST /event`（`127.0.0.1` + `x-pisa-token`）
- GitHub 评论派活：多仓库轮询，按仓库隔离增量下界与去重；PR 上已有任务则接续分支，Issue 来源的任务开新分支并回帖，PR 正文带 `Closes #<n>`
- 主动发现：群聊关键词触发 + 定时探针（命令退出码非 0 即开单）
- 定时任务：cron 到点开单，同一分钟只投一次，`/pisa schedules` 查看
- 崩溃恢复：`running` 任务在进程重启后转 `paused`，`/pisa resume` 拉回；孤儿任务收口、任务级超时
- `/pisa rewind`：只读预览并撤销任务副作用（PR、本地与远程分支、工作副本），已合并任务用 revert 提交回退
- `/pisa merge`：临时副本跑 `bun test`，通过后 `--ff-only` 合入 main，看护进程拉起新代码
- Agent CLI（`pisa task/wait/status/show/logs/cancel`）与 `skills/pisa/` 可复用 skill
- Worker 边界 guard：拦截 push、rebase、`reset --hard`、`clean -f`、分支切换与删除、`worktree remove`、`commit --amend`、sudo、`rm -rf /`、workdir 外的文件读写；规则见 `docs/specs/014-worker-guard/`
- 数据保留：`retentionDays` 定期清理事件与进度文件，日志按 10 MiB 轮转，每周 VACUUM
- 仓库工程化：GitHub Actions 跑 `bun test` 与 `bunx tsc --noEmit`；Issue 表单（bug / feature）；PR 模板含验证与回滚说明；新增 [CONTRIBUTING.md](./CONTRIBUTING.md)、[SECURITY.md](./SECURITY.md)、本文件
