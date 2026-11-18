# 016 · 任务清单

## 数据与队列

- [x] T001 `types.ts`：`EffectState`、`QueuedEffect` (FR-001)
      验证：`bunx tsc --noEmit`
- [x] T002 `store.ts`：`effects` 表、索引与 9 个方法 (FR-001、FR-004~006、FR-010、FR-012)
      验证：`bun test tests/effects.test.ts`
- [x] T003 `src/effects.ts`：`effectBackoffMs`、`EffectQueue` (FR-002、FR-005、FR-006)
      验证：`bun test tests/effects.test.ts`

## 动作

- [x] T004 `github.ts`：`repoFromRemote`、`findOpenPr` (FR-007)
      验证：`bun test tests/github-comments.test.ts`
- [x] T005 `deliver.ts`：push/pr 入队 + 执行器，结果从队列读 (FR-003、FR-007~FR-011)
      验证：`bun test tests/github-comments.test.ts -t 交付`、`bun test tests/router.test.ts -t 推送`
- [x] T006 `router.ts`：回帖入队 + comment 执行器，删 runTask 里的 push/pr 账本 (FR-003、FR-008、FR-010、FR-011)
      验证：`bun test tests/github-comments.test.ts`
- [x] T007 `router.ts`：撤销后取消未完成动作 (FR-012)
      验证：`bun test tests/rewind.test.ts`、`bun test tests/effects.test.ts`

## 装配与文档

- [x] T008 `index.ts`：共享队列、启动与关停；测试里的构造点补齐依赖
      验证：`bunx tsc --noEmit`、`bun test`
- [x] T009 文档：`docs/architecture.md` 模块表、交付/回帖流程与失败模式；README 回帖失败语义；CHANGELOG
      验证：`bun test tests/architecture-doc.test.ts`

## 验收

- [x] T010 走完 `spec.md` 第 5 节 7 条
      验证：`bun test`、`bunx tsc --noEmit`
