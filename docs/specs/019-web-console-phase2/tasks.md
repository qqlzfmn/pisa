# 019 · 任务清单

## 数据与领域

- [ ] T001 `store.ts`：`audit` 与 `queue_samples` 表，`audit` / `recentAudit` / `sampleQueue` / `queueSamples` (FR-009~011)
      验证：`bun test tests/web.test.ts`
- [ ] T002 `metrics.ts`：`MetricBucket` 与 `bucketMetrics` (FR-008)
      验证：`bun test tests/web.test.ts`
- [ ] T003 `rewind.ts`：`rewindPlanJson`，计划标签单一来源 (FR-001, FR-012)
      验证：`bunx tsc --noEmit`
- [ ] T004 `config-file.ts`：`configDraft` / `draftFromFile` / `validateDraft` / `writeConfigPatch` / `sameDraft` (FR-004~006)
      验证：`bun test tests/web-config.test.ts`

## 服务

- [ ] T005 `router.ts`：`previewRewind` / `executeRewind`，`handleRewind` 改薄壳 (FR-001~003)
      验证：`bun test tests/router.test.ts`
- [ ] T006 `router.ts`：每 60 秒队列采样 (FR-009)
      验证：临时库起 Router，60 秒后 `queue_samples` 有行
- [ ] T007 `web.ts`：`/api/tasks/:id/rewind` GET/POST、`/api/config` GET/POST、`/api/metrics`、`/api/audit`，全部写操作记账 (FR-001~011)
      验证：`bun test tests/web.test.ts`、`bun test tests/web-config.test.ts`
- [ ] T008 `index.ts`：把配置文件绝对路径传给 Web (FR-004)
      验证：`bun run web` 后 `GET /api/config` 的 `path` 正确

## 页面

- [ ] T009 `web-ui.ts`：指标三图、配置表单、详情撤销预览与执行、审计表 (FR-012~014)
      验证：浏览器打开 `/ui`，改并发保存 → 提示重启；撤销预览 → 执行 → 状态变已撤销

## 文档与验收

- [ ] T010 文档：`docs/operations.md` Web 控制台小节、`docs/architecture.md` 模块表、`CHANGELOG.md`
      验证：`bun test tests/architecture-doc.test.ts tests/docs-links.test.ts`
- [ ] T011 走完 `spec.md` 第 5 节 6 条
      验证：`bun test`、`bunx tsc --noEmit`
