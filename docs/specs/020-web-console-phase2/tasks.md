# 020 · 任务清单

## 契约与数据

- [x] T001 `rewind.mergeStateLabel` 导出；`Router.previewRewind` 与 `RewindLookup`，`handleRewind` 复用 (FR-001, FR-002)
      验证：`bun test tests/web.test.ts tests/rewind.test.ts`
- [x] T002 `Config.configPath`；`adapters.adapterNames` (FR-003)
      验证：`bunx tsc --noEmit`
- [x] T003 `src/config-edit.ts`：可编辑视图、聚合校验、原子保存 (FR-003~005)
      验证：`bun test tests/config-edit.test.ts`
- [x] T004 `src/audit.ts`：JSONL 追加、尾部读取、脱敏、轮转 (FR-009)
      验证：`bun test tests/audit.test.ts`
- [x] T005 `metrics.buildStatsSeries`；`store.tasksInWindow` (FR-006)
      验证：`bun test tests/metrics.test.ts`

## 服务

- [x] T006 写路由统一 `confirm: true`，覆盖派活/取消/合并/撤销/保存配置 (FR-008)
      验证：`bun test tests/web.test.ts`
- [x] T007 `GET/POST /api/tasks/<id>/rewind`：预览与执行 (FR-001, FR-002)
      验证：`curl` 预览 → 确认执行 → 状态 `rewound`
- [x] T008 `GET/POST /api/config` (FR-003~005)
      验证：非法输入一次列全错误；合法输入落盘并提示重启
- [x] T009 `GET /api/stats`、`GET /api/audit` (FR-006, FR-007)
      验证：`curl '/api/stats?days=999'` 返回 30 桶；审计最新在前

## 页面

- [x] T010 配置表单（仓库/worker/定时任务）、保存确认、重启提示 (FR-010)
      验证：浏览器打开 `/ui`，改并发保存 → 文件更新
- [x] T011 撤销预览与执行按钮、审计表格、成功率/耗时/队列图表 (FR-010)
      验证：详情内预览 → 执行；审计表出现本次操作；图表切换 7/14/30 天

## 集成

- [x] T012 文档：本规格、operations「Web 控制台」、architecture 模块与索引、CHANGELOG
      验证：`bun test tests/docs-links.test.ts`

## 验收

- [x] T013 走完 `spec.md` 第 5 节 7 条
      验证：`bun test`、`bunx tsc --noEmit`
