# 领域模型

术语表。每条给定义、代码位置与容易混淆的地方；流程与约束以代码和 [架构文档](./architecture.md) 为准，这里不复述实现。

## 任务与状态

| 术语 | 定义 | 代码 / 注意 |
| --- | --- | --- |
| 任务（task） | 一条明确需求及其执行记录，落 `tasks` 表 | `src/types.ts` 的 `Task` |
| 任务号（taskId） | `t_<yyyyMMdd>_<6 位十六进制>`，同日可排序 | `src/ids.ts` 的 `newTaskId` |
| 状态（status） | 任务在状态机里的位置，共 7 个值 | `src/types.ts` 的 `TaskStatus`、`ALLOWED`；跃迁表见 [架构 2](./architecture.md#2-任务状态机与恢复语义) |
| 阶段（stage） | 由状态与交付字段派生的「现在等谁」，不写库 | `src/stage.ts` 的 `STAGE_RULES`；看板与详情共用一个口径 |
| 状态板（status board） | 运行中 / 排队 / 最近完成的三段视图 | `src/status.ts`；`/pisa status` 与 `pisa status` 同源 |
| 中断恢复（recover） | 进程重启时给遗留 `running` 任务分流 | `src/router.ts` 的 `recoverInterrupted`；`paused` 可续跑，缺会话或工作副本则 `failed` |
| 续跑（continue） | 用上一轮分支与上下文开一条新任务 | `baseRef` + `context`；`src/task-context.ts` |

`status` 是状态机的唯一输入；`stage` 只是投影。不要用阶段判断任务能否操作，操作校验一律看 `status`。

## 触发与身份

| 术语 | 定义 | 代码 / 注意 |
| --- | --- | --- |
| 事件（message） | 入口收到的一次输入，归一化为 `IncomingMessage` | `src/types.ts`；必填 `eventId`、`channel`、`chatId`、`userId`、`text` |
| 入口名（channel） | 事件来自哪类入口：`cli`、`telegram`、`webhook`、`web`、`github`、`cron`、`proactive` | `IncomingMessage.channel`；同时是触发器身份里的 `source` |
| 事件号（eventId） | 入口内唯一的事件标识，占 `events` 表；被拒的投递不占键 | Webhook 强制 `webhook:` 前缀，其余入口自行生成；前缀用于区分来源，不代替鉴权 |
| 触发身份（trigger） | 判定「同一件事」的五元组，算出的 `id` 落 `triggers` 表 | `src/trigger.ts`；`id = sha256(长度前缀五元组)[:32]`，见 [架构 4.2](./architecture.md#42-trigger加事件源) |
| 线程键（threadKey） | 会话线程：同一件事的后续消息归到这里 | 论坛话题、Issue/PR、业务单号；缺省由 core 按回复任务或本条消息生成 |
| 消息键（messageKey） | 线程内的消息标识，缺省为 `eventId` | 平台消息 id / 评论 id 比自造事件号稳定 |
| 版本（version） | 消息版本，编辑时间一类；无版本概念时为空串 | 同消息不同版本记 `kind=context`，任务排队时可更新需求 |
| 载荷指纹（payloadHash） | 需求正文摘要，CRLF 归一后 trim | `/pisa X` 与裸 `X` 命中同一个指纹 |
| 触发源（source） | 产生事件的外部系统；内置六种 | [架构 4.2 的表](./architecture.md#42-trigger加事件源) |
| 误触保护（taskGuard） | 单个 ASCII 词不直接建任务，先确认或提示打错的命令 | `src/config.ts` 的 `taskGuard` |
| 定时任务（schedule） | cron 到点投一条事件，同一分钟只投一次 | `src/scheduler.ts`；`/pisa schedules` 查看 |
| 主动发现（proactive） | 群聊关键词与定时探针各是一条触发源 | `src/proactive.ts`；冷却在触发源内部 |

`Task.source` 与 `Task.channel` 不是一回事：前者对 IM/webhook 任务存事件号，对 CLI 任务写死 `cli`；后者始终是入口名。按入口分组、做统计时用 `channel`。

## 执行与隔离

| 术语 | 定义 | 代码 / 注意 |
| --- | --- | --- |
| 仓库别名（alias） | 配置里给本地仓库起的短名，消息里用 `@别名` 指定 | `RepoConfig`；`repoByAlias` 解析，未配置即拒单 |
| 白名单（whitelist） | 允许派活的用户与仓库，两道都过才建任务 | `src/router.ts` 的 `checkAccess`；Web 的 `web.userId` 也要在 `whitelist.users` |
| 工作副本（worktree） | 每个任务一个 git worktree，路径 `.pisa/worktrees/<任务号>` | `createWorktree`；任务结束按状态删除或保留 |
| 任务分支 | Worker 的提交落在 `pisa/<任务号>`，不碰主干 | `src/router.ts` 的 `launch`；合并成功后才进入 `baseBranch` |
| 起点（baseRef） | 续跑任务从上一轮分支开始；首轮为空 | `Task.baseRef`；与仓库配置的 `baseBranch` 区分 |
| 会话（sessionId） | agent 自己的会话 id，用于 `resume` 接着原会话执行 | `parseLine` 之外的 adapter 能力；没有会话的 agent 仍可跑，只是 `paused` 无法续跑 |
| Worker | 拉起 agent 进程、转发输出、执行超时与取消的执行器 | `src/worker.ts`；`WorkerRunner` 是 Router 依赖的接口 |
| 适配器（WorkerAdapter） | 把任务翻译成某个 agent 的命令行参数、环境与输出解析 | `src/adapters/types.ts`；实现步骤见 [扩展指南](./extending.md#加-workeradapter) |
| 适配器输入（AdapterInput） | `buildArgs` / `buildEnv` 收到的全部上下文 | `task`、`workdir`、`extensionPath`、`progressFile`、`cfg`、`resume`、`resumeSessionId` |
| 进度文件（progress） | `.pisa/progress/<任务号>.jsonl`，agent 侧 skill 写入，用于卡死检测 | `PISA_PROGRESS_FILE`；没有对应 skill 时该文件不会更新 |
| 环境白名单（envAllow） | Worker 子进程只继承列出的环境变量，缺省见 `DEFAULT_ENV_ALLOW` | `src/config.ts`、`src/worker.ts` 的 `workerEnv`；token 不进 Worker |
| 守护进程（daemon） | 常驻的 pisa 进程，每 800ms 写一次心跳 | `src/router.ts` 的 `start`；心跳超过 10s 视为未运行（`HEARTBEAT_STALE_MS`），`/health` 返回 503 |

## 交付与收尾

| 术语 | 定义 | 代码 / 注意 |
| --- | --- | --- |
| 交付（delivery） | 提交、推送、建 PR 三个动作的组合 | `src/deliver.ts` 的 `GitDeliverer`；`DeliveryResult` 带 `files`、`pushed`、`blocked` |
| 敏感路径（blocked） | 交付时被剔出索引的路径，如工作流、`.env*`、密钥 | `src/git.ts` 的 `isSensitivePath`；全部被拦时不产生空提交 |
| 副作用账本（task_effects） | 已发生的分支、推送、PR、回帖、合并，供 `rewind` 预览 | `src/store.ts` 的 `task_effects` + `Store.effect` |
| 外部动作队列（effects / outbox） | 待执行的推送、建 PR、回帖，先落库再执行，失败退避重试 | `src/effects.ts`；同一 `(kind, key)` 只执行一次 |
| 合并（merge） | 把已完成任务的分支验证后快进合入主干 | `/pisa merge`；`src/router.ts` 的 `handleMerge`：临时 rebase → 有 `tests/` 就 `bun test` → `--ff-only` |
| 撤销（rewind） | 按账本回退分支、推送、PR、回帖；先预览再执行 | `src/rewind.ts`；`/pisa rewind <任务号> [--yes]` |
| 保留（retention） | 每日清过期终态任务的 `events` 与 progress 文件，每周 VACUUM | `src/retention.ts`；默认 30 天。任务日志由 `src/log.ts` 在超过 `LOG_MAX_BYTES` 时轮转 |
| 回执（receipt） | 通道 `send` 返回的消息 id，写入 `task_messages` | `DeliveryReceipt`；没有回执就没有「回复该消息续跑」 |
| 通道（ChannelAdapter） | 入站消息与出站文本的适配器，如 CLI、Telegram | `src/types.ts`；新增通道要改装配，步骤见 [架构 4.3](./architecture.md#43-入口客户端加通道) |

`task_effects` 是「做过什么」的账本，`effects` 是「还要做什么」的队列。撤销读账本；重试读队列。
