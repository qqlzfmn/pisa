# 005 · 中断可续

- 状态：implemented
- 关联：P3（持久与自愈）
- 覆盖：003 的「重启收尾」全部标 `failed`

## 1. 问题

003 里进程重启会把所有遗留 `running` 任务一次性标成 `failed`。这类任务多数不是做错了，而是进程被中断：工作副本还在磁盘上，agent 会话 id 也已落库。标成 failed 等于把已完成的大半工作丢掉，请求者只能重开任务、从头再说一遍需求。

## 2. 目标

- 进程重启后，可恢复的中断任务进入独立状态，不与真正的失败混在一起
- 请求者用一条命令把中断任务拉回执行，复用原工作副本与原 agent 会话
- 恢复只由原请求者发起，且只在任务处于中断状态时成立
- 不可恢复的中断任务仍然明确标记失败，不静默消失

## 3. 状态机

状态集合：`queued`、`running`、`paused`、`succeeded`、`failed`、`cancelled`。

合法跃迁：

| 从 | 到 | 触发 |
| --- | --- | --- |
| `queued` | `running` / `cancelled` | 被调度 / 请求者取消 |
| `running` | `paused` / `succeeded` / `failed` / `cancelled` | 进程重启且可恢复 / 完成 / 出错 / 取消生效 |
| `paused` | `running` / `cancelled` | 请求者恢复 / 请求者放弃 |
| `succeeded` / `failed` / `cancelled` | 无 | 终态 |

约束：

- `queued` 不能直接进入 `paused`（从未开始的任务没有可续的东西）
- `paused` 不自动恢复，必须由请求者显式发起
- `paused` 与 `running` 都可以被请求者取消
- `running` 任务的 `cancel_requested` 已置位时，启动分流优先落地 `cancelled`，不进入 `paused`；取消是写操作的否决票，重启不得把它改写成可 `resume` 的待办

中断归属由两条事实决定，缺一不可：

1. 该任务的工作副本目录仍然存在
2. 该任务的 agent 会话 id 非空

任一不满足 → 任务不可恢复，标 `failed` 并写明原因。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 任务状态新增 `paused`；状态机允许 `running → paused → running`、`paused → cancelled`，拒绝 `queued → paused` |
| FR-002 | 进程启动时对所有遗留 `running` 任务分流：已请求取消的转 `cancelled`，可恢复的转 `paused`，其余标 `failed`；分流过程不删除任何工作副本 |
| FR-003 | 新增恢复命令：`/pisa resume <任务号>`，私聊可直接 `/resume <任务号>` |
| FR-004 | 恢复前校验：任务存在、请求者为本人、状态为 `paused`、工作副本存在；任一不满足则拒绝并说明原因 |
| FR-005 | 恢复时任务从 `paused` 转回 `running`，复用原工作副本（不新建、不重置分支），再次调用 Worker |
| FR-006 | 恢复执行时，Worker 收到原会话 id，并注入固定核对段落：先看工作目录与 `git status`/`git log`，确认分支是否已推送、PR 是否已存在，再决定是否重做推送、建 PR、回帖等外部动作；不重做已完成部分 |
| FR-007 | 恢复被拒绝时不改变任务状态，不占用执行槽位 |
| FR-008 | 恢复成功后，任务按原有交付链路正常提交、回执、清理工作副本 |

## 5. 非目标

- 自动恢复：不做定时重试或启动即续跑；是否继续由请求者决定
- 跨机器迁移：会话与工作副本仍在本机
- 恢复已完成/已失败/已取消的任务
- 保存中断瞬间的进程内状态（只依赖工作副本与会话）

## 6. 验收

1. 状态机：`running → paused → running` 成功；`queued → paused` 被拒
2. 启动分流：`cancel_requested` 已置位的 `running` 任务变 `cancelled` 且之后 `resume` 被拒；工作副本与会话都存在的变 `paused`；缺任一条的变 `failed`；工作副本不被删除
3. `/pisa resume <任务号>` 成功后 Worker 在同一个工作副本目录上再执行一次，任务最终 `succeeded`
4. 非原请求者、非 `paused` 状态、工作副本缺失的恢复请求都被拒绝，状态不变
5. 会话恢复参数出现在 Worker 命令行；恢复任务的提示词包含工作目录、`git log` 与 PR 存在性核对，以及「确认外部动作未发生再执行」的要求；新任务的提示词不含该段落
6. 关停时 Worker 返回后任务保持 `running`，工作副本与分支都还在，且没有 `failed` / `succeeded` 写入
7. `stop()` 之后 `fill()` / `drainOnce()` 不再调度排队任务

## 7. 关停语义

进程收到 `SIGTERM` / `SIGINT` 时，执行中的任务不是失败，而是被中断。中断可续，失败不可续，两条路径必须分开。

- Router 持有 `stopping` 标记，`stop()` 置位后 `fill()` 与 `drainOnce()` 立即返回，不再取排队任务
- `runTask` 在 Worker 返回后检查 `stopping`：为真则直接返回，不写 `failed` / `succeeded`，不 `removeWorktree`，不 `deleteBranch`；任务留在 `running`，工作副本与分支原样保留
- `stop()` 只停止调度并等待，不终止 Worker；最多等 3 秒让执行中的任务收尾，超时后继续关停
- `index.ts` 的 shutdown 顺序：`router.stop(3000)` → 停主动发现 → 停通道 → `store.close()` → `process.exit(75)`；退出码 75 表示临时失败，由 supervisor 重启
- 下次启动 `recoverInterrupted()` 按既有规则处理遗留 `running`：工作副本与会话都在的转 `paused`，其余标 `failed`。因此正常关停后「中断可续」同样成立

约束：关停路径不写任何任务状态。状态写入只发生在 `recoverInterrupted()` 与请求者发起的 `resume` / `cancel` 中。
