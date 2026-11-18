# 018 · 健康与任务指标

- 状态：implemented
- 关联：010-status-board（看板）、015-web-console（控制台与鉴权）、016-readme-landing（文档入口）

## 1. 问题

现在只有日志和 `/pisa status` 看板，两者都是「此刻的列表」，回答不了趋势问题：

- 最近一天成功率掉了没有、慢在哪个分位；
- 队列是在堆积还是在消化；
- 某一台/某一个仓库的任务是不是异常多。

要回答只能人工翻 `.pisa/logs/*.log`，且没有稳定的机器可读出口，监控无法采集。

证据（改动前的代码）：`src/web.ts` 只有 `/ui`、`/api/tasks` 等业务路由，没有任何健康路由；`src/status.ts` 的 `formatStatusBoard` 只输出当前总数（`汇总` 行）与最近完成列表，没有时间窗口聚合；`src/store.ts` 没有按结束时间取任务的查询。

## 2. 目标

- `GET /health` 返回一份机器可读的 JSON 快照：进程与守护进程状态、队列深度、执行中数量、最近 24h 成功率与耗时分位、每仓库任务数
- `/pisa status` 末尾附带同一口径的最近 24h 汇总
- 聚合计算有独立模块与单元测试；看板、CLI、`/health` 共用一份计算，不各写一套
- 没有外部依赖，不新增表，不新增写路径

## 3. 口径定义

窗口固定为最近 24 小时（`METRICS_WINDOW_MS`），以任务结束时间为界；`ended_at` 缺失的历史数据按 `created_at` 判定，与看板「最近完成」的取时规则一致。

| 指标 | 定义 |
| --- | --- |
| 样本 | 窗口中状态为 `succeeded` / `failed` 的任务 |
| 成功率 | `succeeded / 样本数`；样本为 0 时为 `null` |
| 耗时 | `ended_at - started_at`；缺任一时间戳的任务不进耗时样本，负值按 0 |
| P50 / P95 | 最近邻分位：升序排列后取第 `ceil(p% · n)` 个；无耗时样本时为 `null` |
| 队列深度 | 当前状态为 `queued` 的任务数 |
| running | 当前状态为 `running` 的任务数 |
| 每仓库 | `running`、`queued` 现值与 `finished24h`（窗口内样本数）；配置里的仓库即使没有任务也出现 |

`cancelled` / `rewound` 是用户行为，不是执行结果，不计入样本：它们会把成功率与耗时分位带偏，且撤销会让历史成绩回退。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/metrics.ts`：`METRICS_WINDOW_MS`、`WindowMetrics`、`percentile()`、`computeWindowMetrics()`、`windowMetrics(store, now)` |
| FR-002 | `Store` 新增 `finishedBetween(from, to)` 与 `countByRepo()`；前者是窗口指标的唯一查询入口 |
| FR-003 | `GET /health` 不需要 token，返回 `{ ok, uptimeSec, queue, running, last24h, repos, daemon }`；`last24h` 字段为 `finished` / `succeeded` / `failed` / `successRate` / `durationSamples` / `p50Ms` / `p95Ms` |
| FR-004 | `ok` 取守护进程心跳（`daemonState`）：心跳在 10s 内为 `true` 并返回 200，否则 `false` 并返回 503；`/health` 其它方法返回 405 且 `allow: GET` |
| FR-005 | `uptimeSec` 从进程启动时刻算起，整数秒；由 `WebDeps.startedAt` 注入，缺省取创建 Web 应用的时刻 |
| FR-006 | `/pisa status` 看板在 `汇总` 行后增加一行 `最近 24h：完成 N · 成功 n · 失败 n · 成功率 X% · P50 a · P95 b`；无样本时输出 `最近 24h：无完成` |
| FR-007 | `pisa status --json` 增加 `last24h` 字段，内容与 `/health` 的 `last24h` 一致 |
| FR-008 | 聚合与格式化不复制：`src/status.ts` 的 `formatWindowMetrics()` 负责文本，`windowMetrics()` 负责取数与计算 |
| FR-009 | 不新增表、不新增状态、不写入任何指标数据；全部按查询时计算 |

## 5. 验收

1. `curl -s 127.0.0.1:<web端口>/health` 返回 200 与上述 JSON，不需要 token
2. 心跳过期（模拟守护进程停止）时 `/health` 返回 503 且 `ok: false`
3. `/pisa status` 末尾出现 24h 行，数字与库内窗口数据一致
4. `pisa status --json` 的 `last24h` 与 `/health` 同构
5. `tests/metrics.test.ts` 覆盖：空窗口、非终态与取消/撤销被排除、成功率、最近邻分位、缺时间戳的耗时样本、窗口边界
6. `tests/web.test.ts` 覆盖：无 token 200、字段与每仓库视图、心跳过期 503、方法 405
7. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 不做历史留存与时间序列：指标只按当前库现算，不写指标表、不导出 Prometheus 格式
- 不新增独立健康端口：`/health` 挂在 Web 控制台的 HTTP 服务上，因此需要 `web.enabled`（或 `--web`）；只监听 `127.0.0.1`
- 不改 Web 页面 UI，不给控制台加图表
- 不改变任务状态机、恢复语义与现有回执文案
