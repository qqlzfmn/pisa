# 领域模型

本文定义代码和文档共用的词。字段名与 [`src/types.ts`](../src/types.ts)、[`src/store.ts`](../src/store.ts) 一致。

相关文档：[架构](./architecture.md) · [部署与排障](./deployment.md) · [扩展指南](./extending.md)

## 术语表

| 术语 | 含义 |
| --- | --- |
| Source | 事件来源。产生 `IncomingMessage` 并交给 Router，不直接执行任务。 |
| Channel | 可双向通信的 Source：能收消息，也能发回执。CLI、Telegram 属于此类。 |
| Router | 全局调度器。解析、去重、鉴权、建任务、控制并发，不直接改代码。 |
| Worker | 一个任务的执行进程。在独立 worktree 内运行 agent。 |
| Adapter | Worker 适配器。把某一种 agent 的命令行参数、环境变量和输出格式翻译成统一接口。 |
| Task | 一次被接单的工作，含需求、仓库、分支、状态和结果。 |
| `IncomingMessage` | 来源进入系统的统一消息结构。 |
| `eventId` | 事件唯一标识。跨通道、跨重启的幂等键。 |
| 去重 / claim | 把 `eventId` 写入 `events` 表；只有第一次写入成功的事件会继续处理。 |
| 仓库别名 | `repos[].alias`。入口用 `@别名` 指定任务落在哪个仓库。 |
| 白名单 | 允许发任务的用户 id 和仓库别名。两者都通过才接单。 |
| worktree | 每个任务独立的 git 工作副本，位于 `<stateDir>/worktrees/<任务号>`。 |
| 任务分支 | 任务产出的分支。新任务是 `pisa/<任务号>`，续跑沿用父任务分支。 |
| 轮次 / 续跑 | 在已有任务分支上继续同一件事。父任务号记录在 `continue` 命令里。 |
| session | agent 自己的会话 id。用于进程中断后恢复上下文。 |
| 进度文件 | `<stateDir>/progress/<任务号>.jsonl`。Worker 扩展写入，Router 读取并转发。 |
| 交付 | 收集 worktree 改动，提交，按配置推送和创建 PR。 |
| 副作用 | 任务在仓库、远端、GitHub 上留下的可见变化。 |
| 台账 | `task_effects` 表。记录任务产生且仍存在的副作用，供 `rewind` 使用。 |
| PR 绑定 | 任务关联的 PR。续跑时复用，不新建。 |
| `paused` | 进程重启后保留下来、可恢复的中断任务。 |
| `rewound` | 副作用已撤销或已确认无法撤销的终态。 |
| 待确认 | 单个英文词被误触防护拦下后，等待 `confirm` 的 10 分钟窗口。 |
| trigger | 触发词，默认 `/pisa`。私聊可不开触发词。 |
| 看护进程 | `scripts/supervise.sh`。非零退出后按退避重启。 |
| `stateDir` | 状态目录，默认 `.pisa`，存放数据库、worktree 和进度文件。 |

## Task

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | string | 任务号，格式 `t_YYYYMMDD_<6 位十六进制>`。 |
| `source` | string | 创建任务的事件 id，与去重使用同一个值。 |
| `channel` | string | 来源通道名，如 `cli`、`telegram`、`webhook`、`github`、`cron`、`proactive`。 |
| `chatId` | string | 回执目标会话。 |
| `requester` | string | 发起人 id。续跑、取消、合并、撤销都校验它。 |
| `repo` | string | 仓库别名。 |
| `prompt` | string | 本轮需求正文，已剥离触发词和别名。 |
| `status` | TaskStatus | 见[状态迁移](#状态迁移)。 |
| `branch` | string \| null | 任务分支。排队时为空，领取时写入。 |
| `prUrl` | string \| null | 关联 PR。已有值时续跑只推送更新。 |
| `sessionId` | string \| null | agent 会话 id，用于恢复。 |
| `baseRef` | string \| null | 创建 worktree 的起点。续跑时是父任务分支。 |
| `context` | string \| null | 续跑时附加的上一轮信息。 |
| `replyPr` | number \| null | 回执要发到的 PR 编号。 |
| `replyIssue` | number \| null | 回执要发到的 Issue 编号。 |
| `replyRepo` | string \| null | 回执要发到的 GitHub 仓库（`owner/name`）。 |
| `summary` | string \| null | Worker 最终摘要，最多 4000 字符。 |
| `error` | string \| null | 失败原因，最多 2000 字符。 |
| `createdAt` | number | 创建时间，毫秒。 |
| `startedAt` | number \| null | 开始执行时间。 |
| `endedAt` | number \| null | 结束时间。 |
| `cancelRequested` | boolean | 是否已请求取消。Worker 每 2 秒检查一次。 |

## IncomingMessage

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `eventId` | 是 | 稳定唯一键。同一事件重复投递必须得到相同值。 |
| `channel` | 是 | 来源名。 |
| `chatId` | 是 | 回执目标。 |
| `userId` | 是 | 发起人，用于白名单和归属校验。 |
| `text` | 是 | 原始文本，包含触发词和别名。 |
| `repo` | 否 | 显式仓库别名；缺省走 `repos[0]`。 |
| `isDirect` | 否 | 是否私聊。私聊可不开触发词。 |
| `replyToMessageId` | 否 | 被回复的消息 id。命中 `task_messages` 时转成续跑。 |
| `continueFrom` | 否 | 续跑的父任务号。 |
| `replyPr` | 否 | 回执 PR 编号。 |
| `replyIssue` | 否 | 回执 Issue 编号。 |
| `replyRepo` | 否 | 回执 GitHub 仓库。 |
| `receivedAt` | 否 | 来源侧时间，毫秒。 |

## 状态迁移

迁移表定义在 [`src/types.ts`](../src/types.ts) 的 `ALLOWED`：

| 当前 | 允许进入 |
| --- | --- |
| `queued` | `running`、`cancelled` |
| `running` | `paused`、`succeeded`、`failed`、`cancelled` |
| `paused` | `running`、`cancelled` |
| `succeeded` | `rewound` |
| `failed` | `rewound` |
| `cancelled` | `rewound` |
| `rewound` | 无 |

约束：

- `succeeded`、`failed`、`cancelled`、`rewound` 都是终态，除 `rewound` 外不能再改。
- `rewound` 只能由终态进入，且只在 `rewind --yes` 成功应用后写入。
- `paused` 不是自动恢复状态。进程启动只负责把可恢复的 `running` 标成 `paused`，恢复要人发 `resume`。
- 所有状态写入都经过 `store.transition`，它同时校验迁移是否合法。

## 副作用台账

`task_effects` 以 `(task_id, kind, target)` 为主键，重复记录会覆盖。

| kind | target | detail | 何时记录 |
| --- | --- | --- | --- |
| `worktree` | worktree 绝对路径 | 空 | 创建 worktree 后 |
| `branch` | 分支名 | 与他人共享时为 `shared` | 创建分支后 |
| `push` | `origin` | 实际推送的分支名 | 推送成功后 |
| `pr` | PR 编号 | 仓库别名 | 新建 PR 后 |
| `comment` | `<owner/name>#<编号>` | 空 | GitHub 回执发送成功后 |
| `merge` | 目标分支 | `{"base","from","to"}` | 快进合并成功后 |

`rewind` 先只读探测每个副作用是否还存在，再决定动作。已合并的任务优先回退合并提交；PR 仍开启就关闭；远端分支、本地分支、worktree 按存在性删除；评论标记为不可撤销。PR 状态无法确认时保留分支，任务不会进入 `rewound`。

## 仓库与别名

- `repos` 是有序数组，第一项是默认仓库。
- `@alias` 必须在 `repos[].alias` 中精确存在，否则原样保留正文，任务仍走默认仓库。
- 别名可写在触发词前或后：`@family /pisa 改首页` 与 `/pisa @family 改首页` 等价。
- 续跑固定在父任务仓库，`@alias` 不会把续跑带到别的仓库。
- `baseBranch` 缺省是 `main`，同时用于创建 worktree 和 `merge` 的目标分支。

## 续跑与轮次

`continue` 的父任务必须存在、属于当前请求人、并且已经产出了分支。续跑时：

- `baseRef` 设为父任务分支。
- `repo` 强制使用父任务仓库。
- 如果父任务有 `prUrl`，新任务复用同一个 PR。
- 父任务的请求、结果摘要、分支和 PR 评论会拼成 `context`，作为参考信息，不是新指令。
- 新任务仍然有独立任务号和独立 worktree，只是分支与 PR 复用。

## 去重

`claimEvent` 的规则：

1. 事件第一次出现：写入 `events`，继续鉴权和建任务。
2. 事件重复出现：直接返回，不回复、不建任务。
3. 事件被鉴权拒绝：仍然算已领取，不会因为重投而再次提醒。

因此 Source 必须提供稳定的 `eventId`。推荐格式 `<source>:<type>:<key>`，例如 `github:comment:<repo>:<commentId>`、`scheduled:<job>:<本地分钟>`。不要用随机数或当前时间作为唯一键。

## 命令与触发词

命令清单在 [`src/config.ts`](../src/config.ts) 的 `COMMANDS`，解析、错拼建议和 Telegram 菜单都从这里生成。当前命令：`cancel`、`help`、`status`、`schedules`、`continue`、`merge`、`resume`、`rewind`、`confirm`。

- 触发词只接受前缀匹配；`/pisa` 后为空等同 `help`。
- 私聊在 `dmWithoutTrigger` 为真时可以省略触发词。
- 中文别名只参与精确匹配，不参与错拼建议。
- 单个英文词且与菜单命令编辑距离 ≤ 2 时只给建议；其余单个英文词要求 `confirm`。
- 待确认窗口 10 分钟，键为 `chatId:userId`；发任何非 `confirm` 的命令都会丢弃待确认。

## 持久化边界

| 数据 | 位置 | 重启后 |
| --- | --- | --- |
| 任务、事件、消息映射、副作用 | SQLite | 保留 |
| agent 会话 | `tasks.session_id` + agent 自己的存储 | 保留 id，能否恢复取决于 agent |
| 未提交改动 | worktree | 文件保留，但任务状态会按恢复规则变成 `paused` 或 `failed` |
| 进度 | `progress/<任务号>.jsonl` | 保留，仅用于执行期转发 |
| 已发回执和评论 | 通道/GitHub | 不会重发；评论有 markdown 标记去重 |

数据库 schema 在打开时自动创建，并对旧库补充新增列；没有单独的迁移命令。备份与升级步骤见[部署与排障](./deployment.md)。
