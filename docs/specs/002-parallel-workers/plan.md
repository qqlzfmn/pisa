# 002 · 技术方案（plan）

对应 [spec.md](./spec.md)。在 001 的基础上改动，不新增进程。

## 1. 改动点

| 文件 | 改动 |
| --- | --- |
| `src/config.ts` | 新增 `worker.concurrency`（默认 2） |
| `src/store.ts` | 新增 `claimQueued()`：`UPDATE … WHERE status='queued'` 原子占位 |
| `src/router.ts` | `running: boolean` → `active: Map<taskId, Promise>`；`fill()` 补位 |
| `src/index.ts` | 启动时按并发上限调度；退出时等待在跑任务 |
| `src/config.ts` | `parseCommand` 增加 `status` |

## 2. 调度模型

```
每 800ms → fill()
  while active.size < concurrency:
    task = nextQueued()
    if !task: break
    claimQueued(task.id)  // 原子：queued → running
    if !claimed: continue
    active.set(task.id, runTask(task))
```

- 占位在 `runTask` 的第一条同步语句，避免两个槽位取到同一任务
- 任务结束（成功/失败/取消）在 `finally` 中从 `active` 移除，下个周期自动补位
- `drainOnce()` 保留给测试：启动可并发的任务并等全部完成

## 3. 并发安全

- 工作副本目录按任务号隔离 `.pisa/worktrees/<taskId>`
- 分支按任务号隔离 `pisa/<taskId>`
- SQLite 用 WAL；状态写入是单条 UPDATE，天然串行
- 回执只发往任务自己的 `chatId`

## 4. 退出策略

SIGTERM：停止调度 → 等待 `active` 最多 10 秒 → 超时任务保持 `running`，下次启动由 `markOrphansFailed` 收尾。

## 5. 测试

- 并发 2：两个任务 `startedAt` 差值 < 1s，总耗时 < 单任务 × 1.5
- 并发 1：第二个任务 `startedAt` ≥ 第一个 `endedAt`
- 一个失败、一个成功：状态互不影响
- `claimQueued` 对同一任务第二次返回 false

## 6. 风险

| 风险 | 缓解 |
| --- | --- |
| 多任务同时跑 omp，机器负载高 | 默认 2，可配 1；P2 再加资源配额 |
| 磁盘被工作副本占满 | 任务结束即删；失败也删 |
| 分支名冲突（重跑同一任务） | 任务号含随机后缀，冲突概率可忽略 |
