# 016 · 实施计划

## D1 `effects` 表与 `Store` 方法

表结构：

```sql
CREATE TABLE IF NOT EXISTS effects (
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  task_id    TEXT,
  payload    TEXT NOT NULL,
  state      TEXT NOT NULL,      -- pending | running | done
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  last_error TEXT,
  result     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_effects_due ON effects(state, next_at);
```

不复用 `task_effects`：后者是撤销账本（任务成功后才写、撤销时删除、按 `(task_id, kind, target)` 去重），语义是「已经存在的副作用」；`effects` 是待执行动作，两者生命周期相反，合并会让撤销逻辑要区分两种含义。

`Store` 增加：`enqueueEffect`、`effectRow`、`claimEffect`、`completeEffect`、`failEffect`、`dueEffects`、`resetRunningEffects`、`cancelEffects`、`setPrUrl`。`claimEffect` 用带 `state='pending' AND next_at <= ?` 条件的 UPDATE 原子占位，占位失败即「别处已执行」。

`key` 取值：push 与 pr 用任务号；comment 用 `<任务号>:<用途>:<仓库>#<编号>`，同任务对同一讨论串只回一次。

## D2 `src/effects.ts`：队列只做调度，不做业务

`EffectQueue` 持有 store、时钟与「kind → 执行器」映射：

- `enqueue` 直接落库；已有 `(kind, key)` 时 `INSERT OR IGNORE` 不覆盖
- `flush(kind, key)` 立刻尝试一次，返回是否已完成
- `drainDue()` 扫出全部到期行，逐条尝试
- `start()` 先把遗留 `running` 退回 `pending`，再每秒 `drainDue`
- 所有操作经内部 promise 链串行化：外部命令本身是阻塞调用，串行避免同一行被并发执行

退避公式独立成 `effectBackoffMs(attempts) = min(2000 × 2^(attempts−1), 60000)`，`attempts` 是失败次数。

注册重复直接覆盖：执行器由所有者注册一次（测试可能重建 Router），覆盖比报错更稳。

## D3 `GitDeliverer` 注册 push/pr，`Router` 注册 comment

执行器放在拥有上下文的模块：deliverer 知道仓库路径、PR 正文与 gh 能力；Router 知道 stateDir、日志与 gh 执行器。队列本身不认识业务类型，新增动作只需多一个 `register`。

`RouterDeps.effects` 可选，缺省时 Router 自建（`new EffectQueue({ store })`），避免测试装配多一层；`index.ts` 建一个共享队列传给 Router 与 `GitDeliverer` 并 `start()`，关停时 `stop()`。

## D4 幂等由执行器保证，不由队列保证

「先落库再执行」只能保证「崩溃后还会再试」；要保证「重试不产生重复」，执行器必须可重复执行：

- push：同分支重复推送是覆盖写，天然幂等
- comment：沿用 `postReplyOnce` 的隐藏标记检查
- pr：新增 `findOpenPr`（`gh pr list --repo <repo> --head <branch> --state open --json url`），命中则复用链接。查询失败（gh 报错、无凭据）按可重试失败处理：无法确认存在与否时，宁可不建也不冒重复风险

## D5 交付结果从队列读

`deliver` 入队后按 push → pr 顺序 `flush`，然后：

- `pushed` = push 动作 `done`
- `prUrl` = 任务已有链接 ?? pr 动作结果；推送动作未完成时不回落 compare 链接（分支可能没推上去，链接无意义）

PR 动作还把链接写回 `tasks.pr_url`，这样即使本次 `transition` 前崩溃，重启后任务仍有 PR 绑定。

## D6 `push`/`pr` 账本写入下移到执行器

原 `runTask` 在交付成功后记 `push`/`pr` 账本。现在动作可能延后数秒重试完成，账本由执行器在成功时写：`runPush` 记 `push`，`runPr` 记 `pr` 并写 `pr_url`。`runTask` 只消费交付结果。

## D7 撤销与队列

撤销成功的两处 `transition(rewound)` 之后调用 `store.cancelEffects(id, "任务已撤销")`：未完成行标记 `done` 并留原因，后台循环不再重试，避免撤销后又把分支推回去或补发评论。

## D8 测试策略

- `tests/effects.test.ts`：退避公式、同 key 去重、失败排期与到期重试、封顶、重启后 `running` 复位与到期重放、撤销后不再重试
- `tests/effects.test.ts` 交付集成：PR 已存在时复用链接且不调用 `createPr`；推送失败时交付不抛错，恢复远端后到期重试按「先推送再建 PR」顺序完成
- 既有交付与回帖测试改为传入 `effects`，注入 `findPr` 保证不触网

## 风险

- `gh pr list` 在每次交付多一次网络调用；失败可重试，不影响任务状态
- 任务被撤销时动作已执行到一半，`cancelEffects` 只能阻止后续重试，不能撤回已生效的副作用（与回帖原有语义一致）
