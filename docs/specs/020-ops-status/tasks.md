# 020 · 任务清单

## 判定与记录

- [x] T001 `src/config.ts`：`OpsConfig` 与 `Config.ops` (FR-008)
      验证：`bunx tsc --noEmit`
- [x] T002 `src/store.ts`：`deleteMeta` / `metaByPrefix` (FR-012)
      验证：`bun test tests/health.test.ts`
- [x] T003 `src/status.ts`：`daemonState` 参数放宽为心跳源 (FR-011)
      验证：`bun test tests/web.test.ts tests/cli.test.ts`
- [x] T004 `src/health.ts`：`OPS_EXIT`、`configProblems`、`checkOps`、`formatOpsProblems` (FR-001~003)
      验证：`bun test tests/health.test.ts`
- [x] T005 `src/health.ts`：`ComponentHealth`（同消息不重写、`ok` 清零）(FR-004)
      验证：`bun test tests/health.test.ts`
- [x] T006 `src/health.ts`：`OpsWatch` 签名去重与恢复清零 (FR-007、FR-010)
      验证：`bun test tests/health.test.ts`

## 接线

- [x] T007 `src/cli.ts`：`status` 返回体检退出码、人类输出问题行、`--json` 增加 `ops`、帮助文本 (FR-005、FR-006)
      验证：`bun test tests/cli.test.ts`
- [x] T008 `src/github-watcher.ts`：轮询失败记 `github`，整轮成功清除 (FR-009)
      验证：`bun test tests/health.test.ts`
- [x] T009 `src/index.ts`：`gc` 与触发层启动记录部件错误；装配 `OpsWatch` 并在关停时停止 (FR-009)
      验证：`bunx tsc --noEmit` + 手工启动守护进程看日志

## 文档

- [x] T010 `docs/operations.md` 巡检与退出码；`docs/architecture.md` 模块表加 `health.ts`；`skills/pisa/references/commands.md` 退出码补充；CHANGELOG
      验证：`bun test tests/docs-links.test.ts tests/architecture-doc.test.ts`

## 验证

- [x] T011 `bun test` 与 `bunx tsc --noEmit` 通过
