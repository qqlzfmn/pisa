# 019 · 任务

- [x] `src/git.ts`：`localBranches` / `remoteBranches` / `listWorktrees`
- [x] `src/github.ts`：`githubRepoSlug` / `listOpenPrs`
- [x] `src/reconcile.ts`：`planReconcile`（纯计划）、`formatReconcile`、`applyReconcile`、`realPath`
- [x] `src/store.ts`：`allTasks`
- [x] `src/config.ts`：`reconcile` 命令（别名 `对账`，进菜单，带正文）
- [x] `src/router.ts`：`reconcileRealities`（只读探测）、`handleReconcile`、私聊 `/reconcile`、命令分发
- [x] `tests/reconcile.test.ts`：处置矩阵、孤儿、scope 过滤、PR 查询失败、缺失工作副本、预览不改动、`--fix` 清理与保留、失败重试提示、命令解析
- [x] `tests/telegram.test.ts`：菜单命令加入 `reconcile`
- [x] 文档：`docs/specs/019-reconcile/`、`docs/architecture.md` 模块表与索引、`docs/usage.md` 场景表
- [x] 验证：`bun test`、`bunx tsc --noEmit`
