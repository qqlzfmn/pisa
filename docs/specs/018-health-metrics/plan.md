# 018 · 实施计划

## D1 聚合独立成 `src/metrics.ts`，纯函数可测

`computeWindowMetrics(tasks)` 只吃任务数组、不碰库，窗口边界、样本过滤、分位算法都能用构造数据测；`windowMetrics(store, now)` 只负责「取窗口 + 调纯函数」。

理由：指标最容易出错的地方是口径（哪些状态算样本、缺时间戳怎么办），把口径锁在纯函数里，看板、CLI、`/health` 三个出口不会各调各的。

分位用最近邻（nearest-rank）而不是线性插值：结果一定是真实观测到的某个耗时，和「P95 就是第 95 百分位的那个任务」直觉一致，也避免了插值公式实现的边界讨论。

## D2 查询放在 `Store`，一个方法一个用途

- `finishedBetween(from, to)`：`status IN ('succeeded','failed')` 且 `COALESCE(ended_at, created_at)` 落在窗口内。取时规则与 `recentFinished` 的展示口径一致。
- `countByRepo()`：`GROUP BY repo, status`，一次查询拿到每仓库各状态数。

`/health` 需要「每仓库 24h 样本数」，直接在 `finishedBetween` 的结果上按仓库累加，不再发第二个查询。

`countByStatus` 的零值字面量抽成 `zeroCounts()`，两处计数查询共用，避免加状态时漏改一处。

## D3 `/health` 挂在 Web 控制台，但不要求 token

控制台已有 `Bun.serve` 与 `createWebApp` 的纯函数路由，加一条路由没有新的生命周期。`/health` 放在鉴权分支之前：

- 监控采集器通常拿不到 token，要求 token 等于让这个出口不可用；
- 服务只监听 `127.0.0.1`，响应里只有计数与时间，没有 prompt、分支、日志等任务内容；
- 在 015 的 FR-003 里记录例外，避免「所有路由都要 token」的文档与实现打架。

`ok` 取心跳而不是「HTTP 能应答」：HTTP 线程活着但调度循环死掉正是要发现的问题。

`uptimeSec` 由 `WebDeps.startedAt` 注入，缺省取创建 Web 应用的时刻——`index.ts` 在启动时创建服务，两者实际几乎相同；注入让测试可断言确定值。

## D4 文本格式化留在 `status.ts`

`status.ts` 已经拥有 `formatDuration` 与看板文本，`formatWindowMetrics` 放这里能直接复用时长格式，避免 `metrics.ts` 反向依赖 `status.ts` 造成循环。

## D5 `pisa status --json` 带上 `last24h`

脚本消费的 JSON 与看板文本用同一份计算；字段名与 `/health` 的 `last24h` 完全一致，跨出口可以直接对比。
