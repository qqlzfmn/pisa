# 015 · 任务

- [x] `src/types.ts`：`OutboxKind` / `QueuedEffect` (FR-001)
- [x] `src/store.ts`：`effects` 表与 `(done_at, next_at)` 索引、`enqueueEffect` / `effectByKey` / `dueEffects` / `markEffectAttempt` / `markEffectDone` (FR-001, FR-002)
- [x] `src/effects.ts`：`effectDelay`（2s→60s）、payload 类型、`findPrForBranch`、`deliveryEffectHandlers`、`EffectQueue.enqueue/runNow/runDue/start/stop` (FR-003, FR-005, FR-006, FR-007, FR-008)
- [x] `src/git.ts`：`createPr` 收敛为 `CreatePrOptions` (FR-004)
- [x] `src/deliver.ts`：提交后入队 push/pr 并立即尝试，推送失败不再抛错，返回 `pushed` 与 compare 链接 (FR-004, FR-009, FR-010)
- [x] `src/router.ts`：构造 `EffectQueue`（`comment` handler + `onDone` 记账）、`replyToSource` 入队、`start()/stop()` 管理定时器 (FR-004, FR-008, FR-009)
- [x] `tests/effects.test.ts`：入队幂等、结果缓存、退避序列、跨实例接管、`onDone` 时机、未注册 kind、真实推送失败与恢复、PR 崩溃重放、二次交付只建一个 PR (AC-1 ~ AC-5)
- [x] `tests/github-comments.test.ts`：交付路径改为注入队列，既有 PR 更新用例保持通过 (AC-6 回归)
- [x] 复现：改造前同一任务二次交付建出两个 PR（临时脚本，未入库）
- [x] 冒烟：真实 `Router` + 文件库，回帖失败入队 → 重启后定时器重放成功且只发一次
- [x] `docs/specs/015-idem-outbox/`：spec / plan / tasks
- [x] `docs/architecture.md`：模块表、数据流、落盘表、失败模式、已知限制、dsh 对照
- [x] 验证：`bun test`（206 pass）、`bunx tsc --noEmit`
