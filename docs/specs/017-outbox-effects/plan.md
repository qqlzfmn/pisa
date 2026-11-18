# 017 · 实施计划

## D1 新表 `effects`，不复用 `task_effects`

`task_effects` 是「这个任务现在还有哪些副作用要撤销」的账本，rewind 会逐条删；outbox 是「这个外部动作做过没有、要不要重试」的状态机，行要长期保留（失败行留错因）。两者寿命和语义不同，共表会让 rewind 顺手删掉重试依据。

```sql
CREATE TABLE IF NOT EXISTS effects (
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  task_id    TEXT,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL,           -- pending | done | failed
  result     TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_effects_due ON effects(status, next_at);
```

`key` 由调用方按语义给：推送 `push:<taskId>:<branch>`、PR `pr:<taskId>:<branch>`、回帖 `comment:<purpose>:<repo>#<n>:<taskId>`。同一逻辑动作在不同任务/分支下互不干扰。

## D2 `EffectQueue` 持有 Store，不进 Store 内部

`src/effects.ts`：`new EffectQueue(store, {now, onDone, onError})`。退避策略、执行循环、键去重都在队列里；Store 只做 CRUD（`enqueueEffect`、`effectRow`、`dueEffects`、`completeEffect`、`failEffect`、`dropPendingEffects`、`setPrUrl`）。这样退避参数可单测，不需要数据库配合。

`exec` 的语义是「确保这次动作最终发生」：先落库，`done` 直接返回 `result`，`failed` 直接抛错，否则立刻执行一次。同步失败会抛给调用方（保持现有分支行为），但行已经带着 `next_at` 留在库里，后台 `flush` 继续重试。

`flush` 只跑「已注册 handler 的 kind」和 `next_at <= now` 的行，单轮上限 20 条，防抖：上一轮未完成时不并发启动。

`start(interval)` 先 `flush()` 一次（重启重放），再定时。`stop` 清定时器。

## D3 处理器由生产者提供，装配收在 Router

`Deliverer` 增加 `effectHandlers(): {push, pr}`；Router 额外实现 `comment`。`Router` 构造时创建队列（`deps.effects` 可注入，测试用），注册三类 handler，并挂 `onDone`：

| kind | 执行 | 完成时 |
| --- | --- | --- |
| push | `pushBranch`，非 0 抛错 | 账本 `push/origin/<branch>` |
| pr | `claimPr` 命中即返回；否则 `createPr`，失败抛错 | 账本 `pr/<number>/<repo>`，回填 `tasks.pr_url` |
| comment | `postReplyOnce`，`ok:false` 抛错 | 账本 `comment/<repo>#<n>/<PR|Issue> 回帖` |

`deliver` 增加第 4 个参数 `effects: EffectQueue`，`runTask` 原样传下去。推送失败仍抛错、任务判失败（与现状一致）；建 PR 失败被 `deliver` 吞掉、回退 `compare` 链接，effect 留在队列重试（FR-012）。

回帖在 Router 里改成 `await this.effects.exec("comment", ...)`，失败时日志写「已入队重试」，任务终态不变。

## D4 崩溃重放依赖动作自身幂等

进程在「外部动作成功、effect 未标 done」之间崩溃，重启后同一行仍是 pending，会再执行一次。这一步靠既有去重兜住：

- PR：`claimPr` 先 `gh pr list --head <branch>`，头部已有开放 PR 就不建
- 回帖：`postReplyOnce` 先查线程里有没有隐藏标记
- 推送：`git push` 对同分支同内容幂等

因此 outbox 是 at-least-once + 幂等动作，不是事务性 exactly-once。

## D5 失败/取消/撤销时丢弃未完成 effect

失败路径会删工作副本和分支，继续重试只会对不存在的路径报错。`runTask` 的两条终止分支（worker 失败、交付抛错、取消）以及 `handleCancel` 都调 `effects.cancelTask(taskId)`，删 `status='pending'` 行；`done` 行保留作记录。

撤销同理：`handleRewind` 在任何一条落 `rewound` 的分支（无动作可撤、全部动作成功）里调 `effects.cancelTask(taskId)`。否则「建 PR 失败、任务成功」的 pending 行会在用户撤销后继续重放，对着已删分支再建 PR。

## D6 测试

- `tests/effects.test.ts`：键去重、退避序列、终止阈值、重启重放、`cancelTask`、`start/stop`
- `tests/github-comments.test.ts`：既有回帖测试改用队列后仍只发一次；新增 gh 失败 → 任务 succeeded + 队列 pending → 恢复后 flush 补发并写账本
- `tests/router.test.ts`：撤销落 `rewound` 后删掉该任务的 pending 行，`flush` 不再执行它
- 6 处直接调 `deliverer.deliver` 的测试补一个队列参数（`new EffectQueue(new Store(":memory:"))` + 注册 handler）
- `docs/architecture.md` 更新模块表、交付/收尾步骤、落盘表
