# 018 · 任务清单

## 计算与查询

- [x] T001 `src/metrics.ts`：`percentile`、`computeWindowMetrics`、`windowMetrics` (FR-001)
      验证：`bun test tests/metrics.test.ts`
- [x] T002 `Store.finishedBetween` / `Store.countByRepo`，计数零值抽 `zeroCounts` (FR-002)
      验证：`bun test tests/metrics.test.ts`
- [x] T003 `status.formatWindowMetrics` 与看板 24h 行 (FR-006、FR-008)
      验证：`bun test tests/router.test.ts`
- [x] T004 `pisa status --json` 增加 `last24h` (FR-007)
      验证：`bun test tests/cli.test.ts`

## 健康出口

- [x] T005 `createWebApp` 的 `/health`：鉴权前放行、`ok` 取心跳、503、405、每仓库视图 (FR-003~005)
      验证：`bun test tests/web.test.ts`
- [x] T006 `WebDeps.startedAt` 注入 `uptimeSec` 起点 (FR-005)
      验证：`bun test tests/web.test.ts`

## 文档

- [x] T007 015 spec 记录 `/health` 鉴权例外；operations 补健康采集入口与看板 24h 行；architecture 模块表加 `metrics.ts`
      验证：`bun test tests/docs-links.test.ts tests/architecture-doc.test.ts`
- [x] T008 CHANGELOG 增加本次条目
      验证：人工核对
