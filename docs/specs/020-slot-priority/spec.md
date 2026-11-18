# 020 · 槽位与人类优先通道

- 状态：implemented
- 关联：002（并发与 FIFO，非目标里明确不做插队）、010（状态看板）、017（阶段投影）
- 依赖：002、010

## 1. 问题

并发槽位是单一队列，先来先跑。两个槽位被长任务占满时，请求者在同一个任务下追问一句「把测试补上」，或只想查一下 `/pisa status`，都要排到所有新任务后面等几十分钟：

- 追问复用父任务分支，体量通常很小，却和新任务抢同一批槽位；
- 排队顺序只看 `created_at`，人判断不了自己在等谁，也看不出槽位被谁占着；
- `/pisa status` 本身即时回复，但看不出「还有几个槽位、我排在第几、为什么没动」。

复现：并发 1，worker 阻塞在长任务上，队列里先放「新任务乙」「新任务丙」，再发 `continue 父任务 追问一句`。旧代码 `fill()` 只按 `created_at` 取队首，追问状态为 `queued`，排在两个新任务之后；下一个调度周期仍先取新任务。

## 2. 目标

- 槽位显式化：worker 槽位数 = `worker.concurrency`（最小 1），追问槽位固定 1 个，两者独立计数
- 人的追问（`continue`、消息回复续跑、PR 评论续跑）走追问通道，worker 槽位满时也能立即执行
- 新任务永远进 worker 通道，任何情况下都不插队、不占用追问槽位
- `status` 展示两条通道的占用与每个排队任务的原因

## 3. 用户故事

### US-1 满槽追问

作为请求者，两个 worker 槽位都在跑长任务时，我发 `continue <任务号> 补一条测试`，它不等待，直接进入追问槽位执行。

### US-2 新任务不插队

作为维护者，我确认并发满时新 launch 仍按创建时间排队，不会因为请求者是本人或来源不同而提前。

### US-3 看槽位

作为请求者，`/pisa status` 在「运行中」之后显示 `槽位：worker 1/2 · 追问 0/1 · 排队 3`，每个排队任务末尾说明在等哪条通道。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `Lane = "worker" \| "human"`；`slotLimits(concurrency)` 返回 `{ worker: max(1, concurrency ?? 1), human: 1 }`，追问槽位是独立于并发的额外槽位 |
| FR-002 | `Task.lane` 必填，落库列 `lane TEXT NOT NULL DEFAULT 'worker'`；旧库通过 `ALTER TABLE` 补列，存量任务视为 worker |
| FR-003 | `continue`、消息回复续跑、PR 评论续跑创建的任务 `lane = "human"`；新任务、CLI `task`、web dispatch、触发器等一律 `lane = "worker"` |
| FR-004 | `Router.fill()` 按通道分别补位：每条通道的占用数（本进程 `active` 中该 lane 的数量）小于该通道上限时，取该通道 `nextQueued(lane)` 队首。worker 通道仍严格 `created_at` 升序，不因来源或请求者改变顺序 |
| FR-005 | `Store.nextQueued(lane?)` 支持按通道过滤；缺省行为与旧版一致（全场最老的一条） |
| FR-006 | 手动恢复（`/pisa resume`）按任务所属通道判满并给出中文原因，提示里带上该通道名 |
| FR-007 | `status` 输出槽位行 `槽位：worker <占用>/<上限> · 追问 <占用>/<上限>`，有排队时追加 ` · 排队 <n>`；排队行末尾追加原因：槽位已满为 `等 worker 槽位` / `等追问槽位`，未满为 `即将开始` |
| FR-008 | `status --json` 与 web `/api/tasks` 返回 `slots`：`{ limits, running, queued }`，各含 `worker` 与 `human`；`TaskJson` 增 `lane` |
| FR-009 | `status.ts` 的槽位计算是纯函数：给定任务集合与并发数，不读时钟、不依赖 Router 实例 |

## 5. 验收

1. `slotLimits(undefined)` 与 `slotLimits(0)` 的 worker 为 1；`slotLimits(3)` 为 3；human 恒为 1
2. 并发 1、worker 满槽时，队列先入两个新任务再入一个 `continue`：追问立即 running，两个新任务仍 queued 且 `lane = "worker"`
3. 同一场景下追问结束后，worker 任务按创建时间依次执行
4. `status` 文本包含 `槽位：worker 1/1 · 追问 1/1 · 排队 2`，排队行分别以 `等 worker 槽位`、`等追问槽位` 结尾
5. `status --json` 的 `slots` 与库中 running/queued 按 lane 的计数一致
6. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 多级优先级或通用优先级字段（追问是唯一的高优先通道）
- 超时、抢占、暂停运行中的任务来腾槽位
- 跨进程槽位协调：槽位计数以单守护进程的 `active` 为准
- web 控制台的可视化改造（除摘要行的槽位数字）
