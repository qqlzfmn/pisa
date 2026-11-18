# 领域术语

查词用。每条给出代码里的标识、一句话定义、代码位置和对应的规格或文档；行为细节看对应文档，这里不复述。

分层与数据流见 [architecture.md](./architecture.md)，装与排障见 [deployment.md](./deployment.md)，扩展步骤见 [extending.md](./extending.md)。

## 1. 任务与生命周期

| 术语 | 代码里的名字 | 是什么 | 出处 | 详见 |
| --- | --- | --- | --- | --- |
| 任务 | `Task` | 一次需求的执行记录：需求正文、仓库、分支、PR、摘要、错误与时间戳 | `src/types.ts` | `001` |
| 任务号 | `newTaskId()` | `t_<yyyyMMdd>_<6 位十六进制>`；同日可排序，不依赖自增 | `src/ids.ts` | `001` |
| 状态 | `TaskStatus` | `queued` / `running` / `paused` / `succeeded` / `failed` / `cancelled` / `rewound`；跃迁只走 `ALLOWED` | `src/types.ts` | `001` |
| 终态 | — | `succeeded` / `failed` / `cancelled` / `rewound`；前三者能由 rewind 进 `rewound`，`rewound` 不再迁出 | `src/types.ts` | `001` |
| 阶段 | `TaskStage`、`stageText()` | 由状态与「有没有分支/PR」派生的待办标签（等你处理 / 等你评审 / 等空闲槽位 / 执行中 / 无待办）；不写库 | `src/stage.ts` | `017-task-stages` |
| 暂停 | `paused` | 进程中断留下的可恢复态：重启时 `running` 且「有会话 id + 工作副本还在」才转这里，否则转 `failed` | `src/router.ts` | `005` |
| 续跑 | `/pisa continue <任务号> <新要求>` | 在同一分支新开一个任务，提示词带上父任务上下文 | `src/router.ts` | `003` |
| 恢复 | `/pisa resume <任务号>` | 对 `paused` 复用原工作副本与 agent 会话继续执行 | `src/router.ts` | `005` |
| 撤销 | `/pisa rewind <任务号>` | 只读预览效果再按 `--yes` 执行，删分支/PR/工作副本或对已合并代码做 revert | `src/rewind.ts` | `013` |
| 合并 | `/pisa merge <任务号>` | 在临时副本跑测试，通过后 `--ff-only` 合入主干 | `src/router.ts` | `015-repo-ops` |
| 取消 | `cancelRequested` | `running` 只置标记，由执行循环在检查点退出；`queued` / `paused` 直接转 `cancelled` | `src/store.ts` | `001` |

## 2. 触发与线程

| 术语 | 代码里的名字 | 是什么 | 出处 | 详见 |
| --- | --- | --- | --- | --- |
| 触发 | `Trigger` | 一次事件的不可变身份，`id = sha256(source, threadKey, messageKey, version, payloadHash)[:32]` | `src/trigger.ts` | `017-trigger-thread` |
| 触发记录 | `triggers` 表 | 去重与线程归属的唯一凭据；不随保留策略清理，删掉会让重放复活成新任务 | `src/store.ts` | `017-trigger-thread` |
| 来源 | `source`、`IncomingMessage.channel` | 入口名：`telegram` / `cli` / `webhook` / `web` / `github` / `cron` / 自定义 | `src/types.ts` | architecture.md §4.2 |
| 线程 | `threadKey`、`threadKeyOf()` | 同线程的后续消息归到同一任务；入口能声明就声明，否则按被回复任务或本条消息成线程 | `src/trigger.ts` | `017-trigger-thread` |
| 消息标识 | `messageKey` | 线程内的消息 id；评论 id、平台消息 id 比自造事件号稳定 | `src/trigger.ts` | `017-trigger-thread` |
| 版本 | `version` | 消息的编辑时间等；同一条消息的新版本只留痕，不新建任务 | `src/trigger.ts` | `017-trigger-thread` |
| 载荷指纹 | `payloadHash()` | 正文 CRLF 归一 + trim 后的摘要；`/pisa X` 与裸 `X` 命中同一指纹 | `src/trigger.ts` | `017-trigger-thread` |
| 触发者 | `actor` | 真实发起人（PR 评论用评论作者，不以投递身份代替） | `src/types.ts` | `017-trigger-thread` |

## 3. 执行

| 术语 | 代码里的名字 | 是什么 | 出处 | 详见 |
| --- | --- | --- | --- | --- |
| Worker | `Worker`、`WorkerRunner` | 拉起 agent 子进程并收口超时、卡死、取消、退出码 | `src/worker.ts` | `001` |
| 适配器 | `WorkerAdapter` | 拼命令行、备环境变量、逐行解析 stdout；注册表在 `src/adapters/index.ts` | `src/adapters/types.ts` | `004` · architecture.md §4.1 |
| 工作副本 | worktree、`.pisa/worktrees/<任务号>` | 每任务独立的 git worktree；成功/失败/运行中取消后删除，`paused` 保留 | `src/router.ts` | `001` |
| 分支 | `pisa/<任务号>` | 任务自己的分支；`continue` 与 PR 评论复用父任务分支，效果记录里标 `shared` | `src/router.ts` | `001` |
| 会话 | `sessionId` | agent 自报的会话 id；`resume` 用它加 `-r` 接着跑 | `src/router.ts` | `005` |
| 进度 | `.pisa/progress/<任务号>.jsonl` | skill 单向写入的事件流（`session` / `tool` / `blocked` / `done`），core 轮询读取 | `extensions/pisa-worker.ts` | `003` |
| 守卫 | `blockBash()`、`outsideWorkdir()` | 在 agent 进程内拦截危险命令与工作目录外的路径 | `extensions/guard.ts` | `014-worker-guard` |
| 卡死 | `worker.idleTimeoutSec` | stdout 与进度文件都静止超过阈值就杀进程；默认 900 秒 | `src/worker.ts` | `003` |
| 超时 | `worker.timeoutSec` | 单任务总时限；默认 3600 秒 | `src/worker.ts` | `003` |

## 4. 交付与配置

| 术语 | 代码里的名字 | 是什么 | 出处 | 详见 |
| --- | --- | --- | --- | --- |
| 交付 | `GitDeliverer` | 提交改动并按开关推送、建 PR | `src/deliver.ts` | `004` |
| 效果 | `Effect`、`task_effects` 表 | 已落地的外部副作用（分支、推送、PR、回帖、工作副本、合并）；撤销的依据 | `src/types.ts` | `013` |
| outbox | `EffectQueue`、`effects` 表 | 外部动作先落库再执行，同一 `(kind, key)` 只执行一次，失败按 2s→60s 退避 | `src/effects.ts` | `017-outbox-effects` |
| 回执 | `DeliveryReceipt` | 发出去的消息 id；回复某条消息即续跑靠它建立映射 | `src/types.ts` | `006` |
| 通道 | `ChannelAdapter` | 收发消息的入口客户端；选择是 `src/index.ts` 里的显式分支，没有注册表 | `src/types.ts` | `004` |
| 白名单 | `whitelist.users`、`whitelist.repos` | 谁可以派活、哪些仓库可派；空数组表示谁都不放行，必须显式列出 | `src/config.ts` | `008` |
| 状态目录 | `stateDir` | 数据库、日志、进度、工作副本的根；相对路径按配置文件所在目录解析 | `src/config.ts` | `001` |
| 保留 | `retentionDays` | `events` 与进度文件的清理天数；`≤ 0` 关闭清理 | `src/retention.ts` | `014-retention` |
| 看护 | `scripts/supervise.sh` | 进程非 0 退出时退避重启，`0` 退出时停止重启 | `scripts/supervise.sh` | deployment.md |
| 自举 | self-host | pisa 给自己的仓库派活、`merge` 后由看护拉起新代码 | operations.md 自举节 | deployment.md |
