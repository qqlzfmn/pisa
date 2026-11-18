# 021 Web 控制台 Phase 2 任务

- [x] T001 新增 `src/audit.ts`：JSONL 追加、1 MiB 轮转、`recent(limit)` 读尾部 (FR-009)
  - 验证：append 后 recent 返回同一条记录，字段完整
- [x] T002 新增 `src/config-edit.ts`：读取可编辑投影、`validateConfigPatch`、`saveConfigPatch` 原子写 (FR-003/004/005)
  - 验证：非法输入逐条报错；合法 patch 落盘后重新读取一致；`whitelist.repos` 非空时同步
- [x] T003 `src/metrics.ts` 增 `metricHistory`；`src/store.ts` 增 `tasksInWindow` (FR-001/002)
  - 验证：桶起点对齐整点，成功率与 P95 与桶内样本一致，队列深度为桶起点采样
- [x] T004 `src/router.ts` 抽出 `rewindPreview`/`rewindExecute`，`handleRewind` 改为复用，IM 文案不变
  - 验证：既有 rewind 行为（预览、空动作标记、失败不标记）不变
- [x] T005 `src/web.ts` 增 `/api/metrics`、`/api/config`、`/api/audit`、`/api/tasks/:id/rewind`，所有写操作要求 `confirm` 并写审计 (FR-006~010)
  - 验证：缺 confirm 400；保存返回 restartRequired；audit.log 有对应条目
- [x] T006 `src/config.ts` 增 `resolveConfigPath`；`src/index.ts` 用它并把 `configPath`、`audit` 注入 Web
  - 验证：`bunx tsc --noEmit`；Web 保存写回同一文件
- [x] T007 `src/web-ui.ts` 增趋势图、配置编辑器、审计表、撤销预览与实际执行 (FR-011)
  - 验证：页面加载无报错；保存非法配置显示服务端错误；撤销先出预览
- [x] T008 测试：`tests/config-edit.test.ts`、`tests/metrics.test.ts` 补历史、`tests/web.test.ts` 补写操作确认/审计/撤销
  - 验证：`bun test`
- [x] T009 文档：`docs/architecture.md` 模块表、`docs/operations.md` Web 章节、`CHANGELOG.md`
  - 验证：`tests/architecture-doc.test.ts` 通过
