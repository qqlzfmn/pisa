# 018 · 任务

## 规格

- [x] T001 `docs/specs/018-reconcile/spec.md`：残留来源证据、需求、验收、取舍

## 实现

- [x] T002 `src/reconcile.ts`：`planReconcile` 只读核对任务与分支、工作副本、开放 PR；`planReconcile` 只读核对后按工作副本 → 本地分支 → 关闭 PR → 远程分支排序，`applyReconcile` 依序执行；`formatReconcilePlan` / `formatReconcileResult` 文案（FR-002…FR-009）
- [x] T003 `src/store.ts`：`allTasks()` 提供全量任务，供全局归属判定（FR-001/FR-006）
- [x] T004 `src/config.ts`、`src/router.ts`：`reconcile` 命令、私聊 `/reconcile`、探测实现（`git for-each-ref`、`git worktree list --porcelain`、`gh pr list`），`--fix` 成功后 `removeEffect`（FR-001/FR-003/FR-008）
- [x] T005 `src/github.ts`：`Runner` 增加可选 `cwd`，`gh pr list` 落在任务仓库内执行

## 测试

- [x] T006 `tests/reconcile.test.ts`：命令解析；已结束任务四类资源可清理；成功任务保留分支与 PR；运行中/暂停任务保留与缺失报告；共用分支与仍被引用分支保留；孤儿资源；单任务范围；`gh` 不可用；`applyReconcile` 真实 git 仓库删工作副本与分支、关 PR、清账本；Router 端到端 `--fix` 清理失败任务且不动运行中任务；预览不落盘
- [x] T007 `tests/telegram.test.ts`：命令菜单包含 `reconcile`

## 文档

- [x] T008 `docs/usage.md`、`docs/operations.md`、`docs/architecture.md`、`README.md`、`CHANGELOG.md`：命令、入口、失败模式、索引与变更记录

## 验收

- [x] T009 `bun test` 与 `bunx tsc --noEmit` 通过
