# 018 · 槽位计数与人类优先通道

- 状态：implemented
- 关联：002-parallel-workers（并发上限）、010-status-board（看板）、017-task-stages（`working/queued` 阶段）
- 依赖：无

## 1. 问题

`fill()` 只按 `active.size < worker.concurrency` 补位，槽位是隐式的「活跃 Promise 数量」，没有区分任务来源。所有人共用一个 FIFO 队列，因此：

- 两个长任务占满槽位时，人对某个已完成任务追问一句 `continue`（或回复任务消息续跑），新任务按 `created_at` 排在定时任务、webhook、PR 评论之后，要等几十分钟；
- 追问与全新任务在队列里没有区别，人无法从看板看出「为什么在排、能不能插队」；
- `status` 看板只显示任务行，看不到槽位用了几条、上限几条。

证据（改动前的代码）：`src/router.ts` 的 `fill()` 只有 `const limit = Math.max(1, this.deps.cfg.worker.concurrency ?? 1)` 与 `this.active.size < limit`；`src/store.ts` 只有 `nextQueued()`（`ORDER BY created_at`）；`src/status.ts` 的 `formatStatusBoard` 不接收任何槽位信息；`handleResume` 在 `this.active.size >= limit` 时直接拒绝。

## 2. 目标

- 槽位显式计数：普通槽位、优先槽位分别有多少、上限多少
- 人类追问（续跑任务）在普通槽位满时占用优先槽位，立刻进入执行
- 全新任务不插队：普通槽位没空就继续排队，永不占用优先槽位
- `status` 看板显示槽位占用与排队原因
- 槽位状态是 Router 运行时事实，不新增任务状态、不改 SQLite 表结构

## 3. 用户故事

### US-1 满槽时追问

作为请求者，两个长任务在跑时，我 `continue` 一个已完成任务。它不排在队列末尾，而是在一个调度周期内进入 `running`，占用优先槽位。

### US-2 新任务不插队

作为请求者，同一时刻我又 `pisa <需求>` 派一个全新任务。它保持 `queued`，等普通槽位释放，不会抢优先槽位。

### US-3 恢复不排队

作为请求者，普通槽位满时我 `resume` 一个 `paused` 任务，它直接进优先槽位执行，不再回「当前并发已满」。

### US-4 看板解释排队

作为看板读者，`status` 显示 `槽位：普通 2/2 · 优先 0/1`，排队标题说明槽位已满、新任务按序等待、追问可占优先槽；排队里的续跑任务带「追问」标记。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `Config.worker.prioritySlots?: number`：人类追问专用的额外槽位，默认 1；`0` 表示关闭优先通道。普通槽位上限仍是 `worker.concurrency`（最小 1） |
| FR-002 | Router 的活跃任务表记录通道：`Map<taskId, { lane: "normal" \| "priority", done: Promise<void> }>`；槽位占用由这张表派生，不另设计数器 |
| FR-003 | 人类追问的判定：任务 `base_ref` 非空（`continue` 命令、回复任务消息、PR 评论续跑都走这条），即 `src/types.ts` 的 `isFollowup()`；`Store.nextQueuedFollowup()` 取最早的这类排队任务 |
| FR-004 | `fill()` 补位顺序：普通槽位有空时先取最早的排队追问，没有追问才取最早的排队任务；普通槽位满、优先槽位有空时只取排队追问；两档都满则不补位 |
| FR-005 | 全新任务（`base_ref` 为空）只在普通槽位有空时开跑，不占优先槽位、不越过更早的排队任务 |
| FR-006 | `handleResume` 按同一规则选通道：普通槽位有空走普通，否则走优先；两档都满才回「槽位已满」 |
| FR-007 | 查询类命令（`status`、`cancel`、`merge`、`rewind`、`schedules`、`help`、`examples`、`gc`）在事件处理路径上直接执行，不占 Worker 槽位，满槽时照常响应 |
| FR-008 | `formatStatusBoard` 接受可选 `SlotState`：运行中段末尾输出 `槽位：普通 <占用>/<上限> · 优先 <占用>/<上限>（人类追问专用）`；排队标题在队列非空时追加原因：普通槽位未满为「等待补位」，普通已满且优先未满为「槽位已满：新任务按序等待，人类追问占优先槽」，两档都满为「槽位已满：新任务与追问都按序等待」 |
| FR-009 | 排队与运行中列表里的追问任务在需求前加「追问 · 」标记；其他任务行格式不变 |
| FR-010 | CLI `pisa status` 不接进程内槽位状态，输出不变（它读的是库，不是调度器） |

## 5. 验收

1. 普通槽位 1、优先槽位 1：长任务占满普通槽位后，`continue` 出的追问任务在一个调度周期内 `running`，新派任务仍 `queued`
2. 同一配置下再来第二个追问：优先槽位已占，它保持 `queued`
3. 普通槽位满、`prioritySlots: 0` 时追问与新任务都排队，补位顺序仍是先来先跑
4. `handleResume` 在普通槽位满、优先槽位空时把 `paused` 任务拉起来执行
5. `status` 输出包含槽位行与排队原因；排队中的追问行带「追问 · 」标记
6. `Store.nextQueuedFollowup()` 只返回 `base_ref` 非空的排队任务，按 `created_at` 升序
7. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 按用户/仓库分配槽位，或队列优先级数值化
- 抢占正在执行的任务（追问只能等库内的空槽位，不打断在跑的任务）
- 把槽位状态写库或跨进程共享；多副本调度不在范围内
- 取消、合并、撤销的排队化（它们仍是即时命令）
