# 014 · 任务

- [x] `src/metrics.ts`：`METRICS_WINDOW_MS`、`WindowMetrics`、`summarize`（成功率口径 + 最近秩分位）
- [x] `src/store.ts`：`finishedSince(since)`、`activeByRepo()`、`idx_tasks_ended` 索引
- [x] `src/health.ts`：`HealthReport`、`healthReport`、`startHealthServer`
- [x] `src/config.ts`：`health` 配置项与默认值（默认启用，127.0.0.1:8798）
- [x] `src/index.ts`：启动健康服务，端口占用只告警
- [x] `src/router.ts`：看板末行追加近 24h 汇总
- [x] `tests/metrics.test.ts`：成功率、取消口径、分位、空样本、3 位小数
- [x] `tests/health.test.ts`：真实 HTTP 服务、方法约束、24h 边界、每仓库计数
- [x] `tests/router.test.ts`：看板 24h 行与空库文案
- [x] `pisa.config.example.json` / `README.md`：配置与用法说明
- [x] 验证：`bun test`、`bunx tsc --noEmit`

验证命令：

```
bun test tests/metrics.test.ts tests/health.test.ts tests/router.test.ts
bun test
bunx tsc --noEmit
```
