# 领域模型与术语

读代码、Issue 与 PR 时，这些词有固定含义。本页只给定义和代码落点，不复述行为；状态怎么迁移、失败怎么处理见 [architecture.md](./architecture.md)，接新来源的步骤见 [extending.md](./extending.md)，部署与排障见 [deployment.md](./deployment.md)。

## 1. 任务

| 术语 | 含义 | 代码落点 |
| --- | --- | --- |
| 任务（Task） | 从一条需求到一次交付的工作单元。所有状态、分支、工作副本、日志都挂在任务号下 | [`Task`](../src/types.ts) |
| 任务号 | `t_<yyyyMMdd>_<6 位十六进制>`，同时用作分支名、worktree 目录名和日志文件名 | [`newTaskId`](../src/ids.ts) |
| 需求（prompt） | 进入 Worker 的完整提示词。来源消息经触发词剥离后写入，续跑时可能带上一轮上下文 | `Task.prompt` |
| 状态（status） | `queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`、`rewound`。允许的迁移由一张表限定，不在表里的跳转直接拒绝 | [`ALLOWED`](../src/types.ts) |
| 阶段（stage） | 由 `status`、`branch`、`prUrl` 派生的只读投影，回答「现在在等谁」：`person/answer`、`person/review`、`working/queued`、`working`、`idle` | [`taskStage`](../src/stage.ts) |
| 任务模式（mode） | `work` 正常改代码并交付；`review` 只读评审，不建分支、不建可写工作副本、不交付 | `TaskMode`、[`Router`](../src/router.ts) |
| 会话（sessionId） | Worker 自己报告的会话标识。`resume` 靠它接回原会话，而不是重放提示词 | `Task.sessionId` |
| `continue` 与 `resume` | 两个不同动作：`continue` 从已有分支新建一个任务接着做；`resume` 恢复同一个被暂停或中断的任务 | [`Router`](../src/router.ts)、[operations.md](./operations.md#续跑) |

## 2. 入口与触发

| 术语 | 含义 | 代码落点 |
| --- | --- | --- |
| 入站消息（IncomingMessage） | 来源交给 Router 的统一消息：谁、在哪个会话、要做什么、属于哪个仓库、是否续接哪个任务 | [`IncomingMessage`](../src/types.ts) |
| 来源（Source） | 统称，不是仓库里的类型：任何产出一条 `IncomingMessage` 并调用 `Router.handle` 的组件。实现有两种形态，见 [extending.md](./extending.md#2-两种形态) | [`Router.handle`](../src/router.ts) |
| 触发身份（Trigger） | 落库的去重身份：`source` + `threadKey` + `messageKey` + `version` + `payloadHash`，哈希后得到 `id` | [`triggerIdentity`](../src/trigger.ts) |
| `threadKey` | 同一条对话线的稳定键。同线程的后继消息可并进未结束任务；缺省由频道、会话和首条事件推导 | [`threadKeyOf`](../src/trigger.ts) |
| `messageKey` | 来源内的消息标识（评论 id、消息 id、文件事件路径等）。同一条消息编辑后键不变 | `IncomingMessage.messageKey` |
| `version` | 同一条消息的版本。编辑后的消息用新版本挂回原任务，而不是新建 | `IncomingMessage.version` |
| `payloadHash` | 正文归一化后的指纹（CRLF 转 LF、去首尾空白），用于识别「同一事件被重放」 | [`payloadHash`](../src/trigger.ts) |
| `dedupeKey` | 适配器给出的来源级去重键，`dispatch` 在消息没写 `messageKey` 时用它补齐 | [`dispatch`](../src/triggers/types.ts) |
| 触发适配器（TriggerAdapter） | 协议型来源的三段接口：`verify` 验签并解析、`normalize` 归一成任务或忽略、`dedupeKey` 给去重键 | [`TriggerAdapter`](../src/triggers/types.ts) |
| 事件号（eventId） | 入口级幂等键，也决定事件号命名空间（`webhook:`、`cron:`、`github:comment:` 等），越界会被拒绝 | [`IncomingMessage`](../src/types.ts) |
| 通道（ChannelAdapter） | 双向对话入口：接收消息，也负责把回执发回去。与只负责入站的 Source 不是一回事 | [`ChannelAdapter`](../src/types.ts) |
| `actor` 与 `requester` | `actor` 是来源里的实际操作者（评论作者、发送者）；`requester` 是任务归属人，用于权限判断 | `Task.requester`、`IncomingMessage.actor` |
| 白名单 | `whitelist.users` 决定谁可以派活，`whitelist.repos` 决定任务能落到哪些仓库；两者都在 Router 入口校验 | [`Config`](../src/config.ts) |
| 回执（receipt） | 通道发送成功后返回的消息标识；`DeliveryReceipt` 目前只带 `messageId` | [`DeliveryReceipt`](../src/types.ts) |

## 3. 执行与交付

| 术语 | 含义 | 代码落点 |
| --- | --- | --- |
| Router | 核心状态机：鉴权、去重、建单、排队、调度 Worker、交付、回执、撤销、合并。不认识具体通道或 agent | [`Router`](../src/router.ts) |
| Store | SQLite 持久化层。任务、线程消息、触发身份、事件、账本、Outbox 与元数据都在这里；启动时自动建表并补列 | [`Store`](../src/store.ts) |
| Worker | 一次 agent 进程执行：准备环境、spawn、逐行读输出、超时与卡死检测、取消 | [`Worker`](../src/worker.ts) |
| Worker 适配器（WorkerAdapter） | 换 agent 的三段接口：拼参数、注入环境、解析一行输出。Router 不感知具体 CLI | [`WorkerAdapter`](../src/adapters/types.ts) |
| `AdapterInput` | 适配器拿到的只读上下文：任务、工作目录、扩展入口、进度文件、worker 配置、是否续跑 | [`AdapterInput`](../src/adapters/types.ts) |
| `envAllow` | 允许传给 Worker 的环境变量白名单。未列出的变量（包括凭据）不会进入子进程 | [`workerEnv`](../src/worker.ts) |
| 工作副本（worktree） | 每个任务独立的 git 工作树，位于 `<stateDir>/worktrees/<任务号>`；交付与合并后清理 | [`Router`](../src/router.ts) |
| 交付器（Deliverer） | 把工作副本里的改动提交、推送、开 PR，并在失败时登记可重试的外部动作 | [`Deliverer`](../src/deliver.ts) |
| 交付结果（DeliveryResult） | 一次交付的产物：分支、PR URL、改动文件、是否推送、被拦截的文件 | [`DeliveryResult`](../src/types.ts) |
| 账本（Effect） | 已发生的不可逆外部动作：建分支、推送、开 PR、回帖、建 worktree、合并。撤销按账本回退 | [`Effect`](../src/types.ts) |
| Outbox | 事务性外发队列。外部动作先落库再执行，同一 `(kind, key)` 只执行一次，失败按指数退避重放 | [`EffectQueue`](../src/effects.ts) |
| PR 评审 | 对 open PR 的 head SHA 发起的只读任务；同一 PR 同一 SHA 只评审一次，结论回帖到 PR | [`GithubWatcher`](../src/github-watcher.ts) |

## 4. 恢复与运维

| 术语 | 含义 | 代码落点 |
| --- | --- | --- |
| 看护（supervisor） | `scripts/supervise.sh` 循环拉起进程：正常退出不重启，非零退出按 1→30 秒退避重启；launchd 负责开机自启 | [`supervise.sh`](../scripts/supervise.sh) |
| 主动关停 | 收到 SIGINT/SIGTERM 后停止接单、保留 `running` 任务、退出码 75，交给看护重启后转 `paused` | [`shutdown`](../src/index.ts) |
| `paused` 与 `failed` | `paused` 有会话或工作副本，可以 `resume`；`failed` 没有可恢复现场，只能重新投递 | [`recoverInterrupted`](../src/router.ts) |
| 对账（reconcile） | 比对数据库与磁盘/远端，找出孤儿 worktree、本地分支、远端分支、PR，并给出可执行处置 | [`ReconcileFinding`](../src/reconcile.ts) |
| 撤销（rewind） | 按账本逆序回退任务产生的分支、推送、PR、回帖与合并；已合并的任务用 revert 提交 | [`RewindPlan`](../src/rewind.ts)、[`rewindPreview`](../src/router.ts) |
| 保留（retention） | 按 `retentionDays` 清理过期事件与终态任务的进度文件；运行中的任务不动 | [`Retention`](../src/retention.ts) |
| 主动发现（proactive） | 定时扫描可执行仓库，按队列与并发情况主动开任务；有熔断与每日配额 | [`Proactive`](../src/proactive.ts) |
| 定时任务（schedule） | 用 5 段 cron 表达式按时投递固定需求；也能配置 `command` 与告警冷却 | [`Scheduler`](../src/scheduler.ts) |
| 状态目录（stateDir） | 默认 `.pisa`：数据库、worktree、日志、进度文件、审计日志都在这里；相对路径以配置文件所在目录为基准 | [`loadConfig`](../src/config.ts) |
