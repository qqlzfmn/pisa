# 021 · 任务清单

- [x] T001 `docs/domain.md`：术语表，覆盖任务状态、触发身份、阶段、会话、交付、账本、对账、续跑、撤销、保留（FR-001）
- [x] T002 `docs/deployment.md`：安装、升级、常驻（launchd / systemd）、端口与数据、退出码表、排障表（FR-002/FR-005）验证：`bun test tests/docs-cookbook.test.ts`
- [x] T003 `docs/extending.md`：加 Source（`TriggerAdapter`）与加 Adapter（`WorkerAdapter`）的步骤、装配点、配置、测试（FR-003）验证：`bun test tests/trigger-adapters.test.ts tests/adapter.test.ts`
- [x] T004 `docs/architecture.md`、`README.md`、`CONTRIBUTING.md`、`docs/operations.md`：互链与去重，命令只在 `deployment.md` 维护一份（FR-004/FR-006）
- [x] T005 `tests/docs-cookbook.test.ts`：存在性、互链、反引号路径存在、退出码与 `helpText()` 一致（FR-005）验证：`bun test tests/docs-cookbook.test.ts`
- [x] T006 `CHANGELOG.md`：`Unreleased / 新增` 记录三份文档与一致性测试（FR-004）
