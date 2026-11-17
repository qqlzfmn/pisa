# 架构

PISA 是一个常驻的调度系统：入口只负责接事件、鉴权和排队，具体改动由隔离的 Worker 进程完成。所有跨进程状态落在 SQLite，文件改动落在每个任务独立的 git worktree。

相关文档：[领域模型](./domain.md) · [部署与排障](./deployment.md) · [扩展指南](./extending.md)

## 组成

| 模块 | 代码 | 职责 |
| --- | --- | --- |
| 进程入口 | [`src/index.ts`](../src/index.ts) | 读配置、装配组件、启动通道与轮询、处理退出 |
| 调度器 | [`src/router.ts`](../src/router.ts) | 解析消息、去重、鉴权、建任务、控制并发、合并与撤销 |
| 状态存储 | [`src/store.ts`](../src/store.ts) | SQLite 表结构、任务状态迁移、事件去重、副作用台账 |
| Worker | [`src/worker.ts`](../src/worker.ts) | 启动 agent 子进程、解析输出、超时与取消 |
| Worker 适配器 | [`src/adapters/`](../src/adapters/) | 把不同 agent 的命令行与输出格式隔离在调度逻辑之外 |
| 交付 | [`src/deliver.ts`](../src/deliver.ts) | 收集改动、提交、推送、创建 PR |
| Git 操作 | [`src/git.ts`](../src/git.ts) | worktree、分支、提交、远端与 PR 查询的薄封装 |
| 通道 | [`src/channels/`](../src/channels/) | CLI 与 Telegram 的收发 |
| GitHub 评论 | [`src/github-watcher.ts`](../src/github-watcher.ts) | 轮询 Issue/PR 评论并投递任务 |
| 定时任务 | [`src/scheduler.ts`](../src/scheduler.ts) | 5 段 cron，按本地时间每分钟匹配 |
| 主动发现 | [`src/proactive.ts`](../src/proactive.ts) | 群聊关键词与探针命令 |
| Worker 扩展 | [`extensions/pisa-worker.ts`](../extensions/pisa-worker.ts) | 上报进度、拦截破坏性命令 |
| 看护进程 | [`scripts/supervise.sh`](../scripts/supervise.sh) | 非零退出后按退避重启 |
| launchd 安装 | [`scripts/install-launchd.sh`](../scripts/install-launchd.sh) | 把看护进程注册为登录常驻服务 |

## 数据流

```
CLI / Telegram / Webhook / GitHub 评论 / cron / 关键词 / 探针
                              │
                              ▼
                    IncomingMessage
                              │
                              ▼
                         Router.handle
                  去重 → 鉴权 → 建任务（queued）
                              │
                    并发未满时 claimQueued
                              ▼
                   git worktree + agent 子进程
                              │
                 输出行 → 摘要 / session / 进度
                              ▼
                   提交 → 可选推送 → 可选 PR
                              │
                    副作用台账 + succeeded
                              ▼
                     回执到来源通道
```

所有来源最终都调用 `Router.handle`，并传入同一个 `IncomingMessage` 结构。来源之间不共享轮询状态，只共享 Router 和 Store。

## 一次任务的执行顺序

1. **仓库别名**：`@alias 正文` 在解析命令前剥离；别名必须与 `repos[].alias` 精确匹配，未知别名不吞掉正文。
2. **回复映射**：消息若是对某条任务消息的回复，会转成 `continue <父任务号> <正文>`。
3. **命令解析**：只有以 `trigger` 开头的文本进入命令分支；`/pisa` 后面为空等价于 `help`。
4. **误触防护**：单个英文词不直接建任务，与命令编辑距离 ≤ 2 时给建议，否则要求 `confirm`。待确认状态 10 分钟内有效。
5. **事件去重**：`store.claimEvent(eventId, taskId)` 先落库。**去重在鉴权之前**，所以重复事件和被拒绝的事件都不会再次处理。
6. **鉴权**：用户白名单、仓库白名单、仓库路径是否为 git 仓库。拒绝原因回一条消息，同一用户 24 小时内只提醒一次。
7. **落任务**：状态 `queued`，回执 `已接单 · <任务号>`。
8. **领取**：`fill()` 按 `worker.concurrency` 领取最早的 queued 任务，原子改成 `running`。
9. **工作副本**：`fill()` 在没有预设分支时把 `pisa/<任务号>` 写进任务。IM 续跑以父任务分支为 `baseRef` 新建自己的分支，不移动父任务分支；只有 PR 评论续跑预先带父任务分支，直接复用。
10. **执行**：Worker 适配器拼参数，子进程在 worktree 内运行；Router 每 2 秒读进度文件并转发。
11. **交付**：收集改动，提交；按配置推送；按配置创建 PR。
12. **收尾**：写副作用台账，状态改 `succeeded`，删除 worktree，回执摘要。
13. **失败或取消**：同样删除 worktree；自有分支一并删除，任务进入 `failed` 或 `cancelled`。

## 任务状态机

```
queued ──► running ──► succeeded ──┐
   │          │  │                 │
   │          │  └──► failed ──────┤
   │          │                    ├──► rewound
   │          ├──► paused ──► running
   │          │       └─────► cancelled
   └──► cancelled
```

允许的迁移只在 [`src/types.ts`](../src/types.ts) 的 `ALLOWED` 中定义，`store.transition` 是唯一写状态的地方。完整字段与语义见[领域模型](./domain.md)。

进程重启时，`running` 任务如果同时有 `session_id` 和未删除的 worktree，会进入 `paused`；否则标为 `failed`，错误为 `进程重启，任务中断`。`paused` 不会自动恢复，需要 `resume`。

## 持久化

SQLite 默认在 `<stateDir>/pisa.db`，开启 WAL。核心表：

| 表 | 内容 |
| --- | --- |
| `tasks` | 任务主体、状态、分支、PR、会话、上下文、时间 |
| `task_messages` | 通道消息 id 到任务 id 的映射，用于“回复即续跑” |
| `events` | 已领取的 `eventId`，用于跨重启去重 |
| `task_effects` | 任务产生的分支、推送、PR、评论、worktree、合并 |

目录布局：

```
.pisa/
├── pisa.db
├── worktrees/<任务号>/
├── progress/<任务号>.jsonl
├── logs/<任务号>.log
└── verify/<任务号>/          # merge 验证副本，结束后删除
```

worktree 和进度文件是执行期产物，不参与去重或状态判断；删除 worktree 会让 `paused` 任务无法恢复。备份与清理命令见[部署与排障](./deployment.md)。

## 进程生命周期

启动顺序：加载配置 → 创建 Store → 选通道 → 创建 Router（Worker 与交付器在这里装配）→ 恢复中断任务 → 启动通道 → 启动调度定时器 → 启动主动发现、GitHub 轮询、定时器 → 可选启动 webhook → 打印：

```
[pisa] ready · channel=<通道> · repos=<别名列表> · concurrency=<并发数>
```

退出：`SIGINT` / `SIGTERM` 触发一次幂等关闭，依次停止调度器、主动发现、GitHub 轮询、定时器、通道，关闭数据库，以 `75` 退出。启动阶段配置错误、缺少通道 token 或没有启用通道以 `1` 退出；正常结束以 `0` 退出。看护进程把任何非零退出都视为需要重启。退出码全表见[部署与排障](./deployment.md#退出码)。

## 关键约束

- **去重先于鉴权**：事件一旦被领取，即使随后被拒绝也不会重放。
- **状态单写者**：只有 `store.transition` 改任务状态，并且必须符合 `ALLOWED`。
- **一任务一 worktree**：Worker 的工作目录就是 worktree，提示词要求不越界。
- **交付只在成功后**：任务失败或取消不提交、不推送、不建 PR。
- **PR 绑定稳定**：带 `pr_url` 的任务（PR 评论续跑）交付时只推送更新，不新建 PR；IM 续跑不继承父任务的 PR。
- **合并先验证再快进**：`merge` 在 `<stateDir>/verify/<任务号>` 建临时 worktree，目录里有 `tests/` 或 `test/` 就跑 `bun test`；通过后要求主工作区当前在 `baseBranch`（默认 `main`），最后 `git merge --ff-only`。
- **台账只记仍存在的东西**：`rewind` 只处理台账里仍能验证的副作用；PR 状态未知时保留分支。
- **配置只在启动时读**：改 `pisa.config.json` 后必须重启进程。
- **同一 stateDir 只跑一个实例**：任务领取依赖进程内调度加 SQLite 原子迁移，没有实例间协调。

## 进一步阅读

- [领域模型](./domain.md)：术语、字段、状态迁移、副作用台账。
- [部署与排障](./deployment.md)：安装、升级、常驻、退出码、故障表。
- [扩展指南](./extending.md)：新增 Source、Worker 适配器和通道。
- [`docs/specs/`](./specs/)：每个功能的规格与实现记录。
