# 016 · 任务清单

## 撤销

- [x] T001 `rewind.ts` 导出 `rewindProbes` / `executeRewind` / `formatRewindOutcome` / `MERGE_LABEL` (FR-018)
      验证：`bun test tests/router.test.ts`

## 配置

- [x] T002 `Config.configPath`，`loadConfig` 记录绝对路径 (FR-019)
      验证：`bun test tests/config-edit.test.ts`
- [x] T003 `src/config-edit.ts`：投影、`parseEditable`、`saveEditableConfig`、摘要 (FR-020~021)
      验证：`bun test tests/config-edit.test.ts`

## 指标与审计

- [x] T004 `Store.dayStats` / `Store.queueDepthAt` 与 `src/metrics.ts` (FR-022~023)
      验证：`bun test tests/web.test.ts`
- [x] T005 `src/audit.ts`：追加、脱敏截断、超限裁剪、读取 (FR-024)
      验证：`bun test tests/web.test.ts`

## 接口

- [x] T006 `GET|POST /api/tasks/<id>/rewind`，复用撤销模块 (FR-016~017)
      验证：`bun test tests/web.test.ts`
- [x] T007 `GET|PUT /api/config`，校验失败不落盘 (FR-019~021)
      验证：`bun test tests/web.test.ts`
- [x] T008 `GET /api/metrics`、`GET /api/audit` (FR-022~024)
      验证：`bun test tests/web.test.ts`
- [x] T009 `requireConfirm` 覆盖全部写操作并写审计 (FR-025)
      验证：`bun test tests/web.test.ts`

## 页面

- [x] T010 指标三图、配置编辑器、撤销面板、审计表、写操作确认框 (FR-026~027)
      验证：真实服务打开 `/ui`，改配置 → 保存 → 审计出现条目

## 文档

- [x] T011 `docs/operations.md` Web 控制台章节、审计说明；architecture 模块表补 `audit`/`metrics`/`config-edit`
      验证：`bun test tests/architecture-doc.test.ts tests/docs-links.test.ts`

## 验收

- [x] T012 走完 `spec.md` 第 5 节 7 条
      验证：`bun test`、`bunx tsc --noEmit`
