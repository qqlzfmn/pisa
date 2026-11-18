# pisa 领域模型

术语表。每条给：定义、容易混淆的边界、代码位置。代码是唯一事实源；这里只保证同一个词在 issue、spec、代码、回执里指同一件事。

分层与数据流见 [architecture.md](./architecture.md)；安装与排障见 [deployment.md](./deployment.md)。

## 术语

| 术语 | 定义 | 边界 | 代码位置 |
| --- | --- | --- | --- |
| 任务 Task | 一次可被取消、暂停、续跑、撤销的工作单元。落库后由状态机推进。 | 不是「会话」：一个任务可以多次执行（恢复、续跑前序会话），会话只是执行时用到的上下文。 | `src/types.ts` 的 `Task`、`src/store.ts` |
| 任务号 | `t_<yyyyMMdd>_<6 位十六进制>`。同日按创建先后可排序。 | 与分支名 `pisa/<任务号>`、日志文件名同源，不要另造标识。 | `src/ids.ts` 的 `newTaskId` |
| 请求者 requester | 任务的归属人。取 `IncomingMessage.userId`（任务字段名是 `requester`），必须是白名单用户；决定任务的可见性与命令权限。 | 与 actor 不同：actor 是平台侧真实发送人，只做留痕；触发器启用时两者可以不同。 | `src/types.ts`、`src/router.ts` |
| 触发 Trigger | 一次入口事件的持久化身份，与任务在同一事务落库。同一条消息重复投递命中同一个触发记录。 | 不是任务：触发可以只作为上下文补充（`kind: "context"`）记到已有任务上，不建新任务。 | `src/trigger.ts`、`src/store.ts` 的 `triggers` 表 |
| 触发身份 | `id = sha256(source, threadKey, messageKey, version, payloadHash)` 取前 32 位十六进制。五段任一变化就是新触发。 | 编辑后的消息 `version` / `payloadHash` 变化，会得到新的触发记录；Router 按线程找到未结束任务，把它作为 `kind: "context"` 记到同一任务，所以编辑不新建任务。 | `src/trigger.ts` 的 `makeTrigger`、`digest` |
| 线程键 threadKey | 归并后续消息的会话键，例如 Telegram 的 chat+topic、GitHub 的仓库+Issue/PR、`file-watch:<路径>`。 | 同一 threadKey 的后续消息会并进未结束任务（`queued` / `paused`）的上下文。 | `src/router.ts`、`src/triggers/` |
| 消息键 messageKey | 线程内的消息标识：评论 id、消息 id、事件 id。 | 与线程键一起才唯一；单独看会串行。 | `src/trigger.ts` |
| 载荷指纹 payloadHash | 正文归一化（`\r\n` → `\n`、去首尾空白）后的 hash。 | 同一消息经不同入口搬运时指纹不变，用来判「同一条」。 | `src/trigger.ts` 的 `payloadHash` |
| 事件与事件号 eventId | 一次入站消息的唯一编号，由通道命名空间加原 id 组成，例如 `telegram:<chat>:<msg>`、`github:comment:<id>`、`cron:<job>:<时间槽>`、`webhook:<id>`。 | 命名空间是安全边界：webhook 入口只接受 `webhook:` 前缀，不能占用其它通道的事件号。 | `src/router.ts` 的 `handle`、`src/webhook.ts` |
| Source（触发源） | 把外部事件翻译成 `IncomingMessage` 并投给 Router 的入口。实现 `TriggerAdapter` 或直接调 `router.handle`。 | 与「通道」不同：通道负责把回执发出去，Source 只负责把事件收进来。 | `src/triggers/types.ts`、`src/triggers/index.ts` |
| 通道 Channel | 出站适配器：把回执、进度、命令菜单发到某个平台。 | 只做收发文本，不做任务决策；核心层不认识具体通道。 | `src/types.ts` 的 `ChannelAdapter`、`src/channels/` |
| 仓库别名 repo alias | 配置里给一个本地仓库起的短名（如 `demo`），任务是按别名找仓库的。 | 任务记录只存别名，不存绝对路径；别名改路不影响历史任务。 | `src/config.ts` 的 `repos`、`RepoConfig` |
| 工作副本 worktree | 任务执行用的独立 git worktree，路径 `.pisa/worktrees/<任务号>`，分支 `pisa/<任务号>`。 | 不是主仓库：主仓库只做 fetch / merge；任务结束时工作副本被回收。 | `src/git.ts`、`src/router.ts` |
| 任务分支 | `pisa/<任务号>`；续跑、撤销、对账都靠这个命名找资源。 | 共享分支（多任务同分支）时账本 detail 记 `shared`。 | `src/router.ts` 的 `store.effect(..., "branch", ...)` |
| Worker | 在 worktree 里执行需求的外部 agent 进程，一次任务一次进程。 | 不是 Router：Worker 不直接对外说话，所有输出经 Router 投影成回执。 | `src/worker.ts` |
| WorkerAdapter | Worker 的命令行适配器：决定怎么拼参数、注入哪些环境变量、怎么解析输出行。 | 换 agent 只实现这个接口；`WorkerRunner` 与 Router 不改。 | `src/adapters/types.ts`、`src/adapters/index.ts` |
| 交付 Delivery | 任务成功后把改动提交（必要时推送、建 PR）并回执的过程。 | 不是「发布」：交付只到分支/PR，合并不由任务自动完成。 | `src/deliver.ts`、`src/git.ts` |
| 交付回执 DeliveryReceipt | 交付结果的结构化记录：分支、提交、PR 链接、被剔除的敏感路径、错误。 | 与命令回执不同：命令回执是给人看的文本，回执对象是给程序看的。 | `src/types.ts` 的 `DeliveryReceipt` |
| 副作用 effect | 任务对系统外部留下的事实：`worktree`、`branch`、`push`、`pr`、`comment`、`merge`。 | 不是日志；它是可被撤销与对账的对象。 | `src/types.ts` 的 `EffectKind`、`task_effects` 表 |
| 账本 ledger | `task_effects` 表：记录仍然存在的副作用，撤销或自然回收后删行。 | 只记「现在有什么」，不记历史；历史看日志与 `events`。 | `src/store.ts` 的 `effect` / `removeEffect` / `effectsOf` |
| outbox | `effects` 表：外部动作「做过没有、要不要重试」。按 `(kind, key)` 至多执行一次，失败按退避重试。 | 与账本互补：outbox 是待办与重试，账本是既成事实。 | `src/effects.ts`、`src/store.ts` 的 `enqueueEffect` |
| 状态 status | 任务的持久化生命周期：`queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`、`rewound`。 | 终态只有 `succeeded`、`failed`、`cancelled`、`rewound`，不会再变；`paused` 是唯一可被 `resume` 复活的状态。 | `src/types.ts` 的 `TaskStatus` 与 `ALLOWED` 转换表 |
| 阶段 stage | 由 status、branch、prUrl 派生的只读投影，回答「在等谁」：`person/answer`（等你处理）、`person/review`（等你评审）、`working/queued`（等空闲槽位）、`working`（执行中）、`idle`（无待办）。 | 不是状态：stage 由 status 算出，不能写回；同一 status 可因有无分支落到不同 stage。 | `src/stage.ts` 的 `STAGE_RULES` |
| 暂停与续跑 | `paused` 是执行被中断但可继续的任务；`resume` 把它放回 `queued` 并携带原会话 id 与基点。 | 与恢复不同：恢复是进程重启后对遗留任务的分流，续跑是人对暂停任务的显式动作。 | `src/router.ts` 的 `resume`、`recoverInterrupted` |
| 恢复 recover | 进程启动时把遗留的 `running` 任务按规则分流：可续的转 `paused`，`cancel_requested` 的直接 `cancelled`。 | 不需要人操作；日志会打印三类计数。 | `src/index.ts`、`src/router.ts` 的 `recoverInterrupted` |
| 撤销 rewind | 把一个任务留下的副作用按探测结果回退：删工作副本、关 PR、删本地/远端分支；已合并的用 `revert` 提交而不是改写历史。 | 不可逆的动作（已推送的历史、已合并的远端）会列出来而不是假装成功。 | `src/rewind.ts` |
| 对账 reconcile | 把任务记录与实际资源（分支、工作副本、PR）逐项比对，给出 `fixable` / `keep` / `missing` / `unknown` 处置。 | 先出计划再执行；`--fix` 才动资源，默认只读。 | `src/reconcile.ts`、`src/router.ts` 的 `reconcile` |
| 保留 retention 与回收 gc | `retentionDays`（默认 30）控制 `events` / `progress` 的保留；`gc` 清过期行、轮转日志、周期性 `VACUUM`。 | 回收不删任务与账本；删任务记录需要显式操作。 | `src/retention.ts`、`src/router.ts` 的 `gc` |
| 心跳 heartbeat | 守护进程周期性写入 `meta` 的 `heartbeat`；`/health` 的 `ok` 取心跳是否新鲜，而不是 HTTP 是否存活。 | 心跳停了即使端口还通也返回 503。 | `src/status.ts` 的 `daemonState`、`src/web.ts` 的 `healthResponse` |
| 合并闸门 merge | `/pisa merge <任务号>` 在临时副本里按白名单环境变量跑 `bun test`，通过后才把任务分支合进仓库的 `baseBranch`（缺省 `main`）。 | 验证失败或超时只回执，不改主干；验证不写回任务 worktree。 | `src/router.ts`、`docs/specs/020-merge-verify-isolation/` |
| 评审任务 review | `mode: "review"` 的只读任务：只读 PR diff、不检出代码、不建分支、不交付，结论回帖到 PR。 | 与普通任务共用状态机，但跳过 worktree 与交付路径。 | `src/pr-review.ts`、`src/github-watcher.ts` |

## 易混词

- **status 与 stage**：status 是存下来的事实，stage 是算出来的视图。读看板看 stage，写逻辑看 status。
- **触发与事件**：触发是落库的身份（`triggers` 表），事件是入站消息本身（`IncomingMessage`）。一条事件可能命中已有触发（重复投递），也可能被拒（鉴权、白名单）。
- **requester 与 actor**：requester 决定权限与归属，actor 只做记录。触发器把 requester 固定为 `triggers.userId`，平台发送人只进 actor。
- **账本与 outbox**：账本记「已经有什么」，outbox 记「还要做什么」。账本删行表示资源已不存在；outbox 删行表示动作已终结。
- **续跑与恢复**：续跑是人的动作，`/pisa resume` 把 `paused` 任务放回队列；`continue`（`pisa continue`）带新要求开一个接续前序会话的新任务；恢复是进程启动时对遗留 `running` 任务的自动分流。
- **撤销与回滚**：撤销是选择性地回退单个任务的副作用；回滚是发布层面的整体回退，pisa 不提供。
- **通道与来源**：来源收事件，通道发文本。加一个 IM 平台通常两者都要加；加一个 webhook 只需要来源。
