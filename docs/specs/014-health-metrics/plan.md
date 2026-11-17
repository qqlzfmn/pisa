# 014 · 实施计划

## D1 聚合独立成纯函数 `src/metrics.ts`

导出：

- `METRICS_WINDOW_MS = 86_400_000`
- `summarize(tasks, now)` → `WindowMetrics`

输入是「已按窗口筛选过的终态任务」，函数只做分组计数与分位计算，不碰存储与时钟（`now` 只用于确定窗口起点由调用方算好，实际不参与计算）。纯函数可单测，Router 与 /health 共用同一份算法，避免两处口径漂移（FR-007 ~ FR-010）。

分位用最近秩：排序后 `index = ceil(p * n) - 1`，`p=0.5/0.95`。耗时为 `endedAt - startedAt` 只取两者都存在的任务（FR-010）。

成功率保留 3 位小数，分母为 `succeeded + failed`，`cancelled`/`rewound` 只计数（FR-008、FR-009）。

## D2 存储层补两个只读查询

- `Store.finishedSince(since)`：终态任务且 `ended_at >= since`，返回 `Task[]`。新增索引 `idx_tasks_ended ON tasks(status, ended_at)` 支撑窗口查询。
- `Store.activeByRepo()`：`status IN ('running','queued')` 按 `repo,status` 分组的计数。

不在 Store 里算分位或成功率：SQL 表达分位要窗口函数，SQLite 版本差异大，且在 JS 里算更直观、更好测（FR-014 只要求无外部依赖）。

## D3 `src/health.ts` 负责快照与 HTTP

- `healthReport(store, startedAt, now)`：同步组装 `HealthReport`，调用 D1/D2 构件。`repos` 由 `activeByRepo` 与窗口内终态任务按仓库合并，过滤全零项并按仓库名排序（FR-006）。
- `startHealthServer({ store, port, startedAt, now? })`：`Bun.serve`，只接受 `GET /health`；其它路径 404，其它方法 405（FR-001）。快照抛错时返回 503 `{ok:false,error}`（FR-003）。
- 端口写死 `127.0.0.1`（非目标里明确不做远程监听）。

`Bun.serve` 是运行时内置，不新增依赖。

## D4 配置与启动接线

- `Config.health?: { enabled: boolean; port: number }`，默认 `{ enabled: true, port: 8798 }`，写进 `DEFAULT_CONFIG` 与 `pisa.config.example.json`（FR-013）。
- `index.ts`：`health.enabled` 时启动；`Bun.serve` 抛错（端口占用）只 `console.error` 告警，不阻断启动。关停时不单独处理（进程退出即释放）。

默认启用：健康探活是常驻服务的必备面，默认关闭等于没有；端口使用独立 8798，避免与 webhook 8799 冲突。

## D5 看板追加末行

`Router.statusBoard` 复用 `store.finishedSince(now - METRICS_WINDOW_MS)` 与 `summarize`，拼一行：

```
近 24h：完成 3 · 成功率 66.7% · P50 20s · P95 1m0s
```

无终态任务时 `近 24h：(无完成)`；成功率为 null 时百分比显示 `-`；分位 null 显示 `-`（FR-011、FR-012）。`formatDuration` 复用现有导出。

## 验证

- `tests/metrics.test.ts`：成功率分母口径、取消不入分母、最近秩分位（10/20/60s → P50 20s、P95 60s）、空样本、单样本、3 位小数
- `tests/health.test.ts`：`port: 0` 起真实服务，断言 200 JSON 字段、POST 405、跨 24h 边界排除、每仓库计数排序；`healthReport` 对已关闭 Store 抛错路径
- `tests/router.test.ts`：看板包含 24h 行，空库显示 `(无完成)`
- `bun test`、`bunx tsc --noEmit`
