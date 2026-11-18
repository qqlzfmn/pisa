# 017 · 任务清单

## 数据与队列

- [x] T001 `Store`：`effects` 表、`enqueueEffect` / `effectRow` / `dueEffects` / `completeEffect` / `failEffect` / `dropPendingEffects` / `setPrUrl` (FR-001, FR-003~005)
      验证：`bun test tests/effects.test.ts`
- [x] T002 `src/effects.ts`：`EffectQueue.exec/flush/start/stop/cancelTask` 与退避策略 (FR-002, FR-004~006)
      验证：`bun test tests/effects.test.ts`

## 接入

- [x] T003 deliverer：`effectHandlers()` 与 `deliver(task, workdir, repo, effects)`，推送/建 PR 入队 (FR-007, FR-009, FR-012)
      验证：`bun test tests/github-comments.test.ts`
- [x] T004 Router：创建并注册队列、`start/stop` 联动、`onDone` 写账本与回填 `pr_url` (FR-008)
      验证：`bun test tests/router.test.ts tests/github-comments.test.ts`
- [x] T005 Router：回帖改为入队执行，失败日志注明重试 (FR-007, FR-011)
      验证：`bun test tests/github-comments.test.ts`
- [x] T006 失败/取消路径丢弃未完成 effect (FR-010)
      验证：`bun test tests/effects.test.ts`
- [x] T010 Router：撤销落 `rewound` 时丢弃未完成 effect (FR-013)
      验证：`bun test tests/router.test.ts`

## 文档与回归

- [x] T007 `docs/architecture.md` 模块表、交付与收尾步骤、落盘表更新
- [x] T008 `CHANGELOG.md` 新增条目
- [x] T009 `bun test` + `bunx tsc --noEmit` 全量通过
