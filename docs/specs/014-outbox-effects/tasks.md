# 014 · 任务

- [x] `src/types.ts`：`EffectJobKind` / `EffectJobStatus` / `EffectJob` / `EffectOutcome`
- [x] `src/store.ts`：`effects` 表与索引、`enqueueEffect` / `effectJob` / `pendingEffects` / `deferEffect` / `settleEffect`
- [x] `src/effects.ts`：`EffectQueue`、`EffectEnqueuer`、退避选项
- [x] `src/deliver.ts`：`runEffect` 执行 push/pr；`deliver` 改经队列，`push` 键含 HEAD
- [x] `src/router.ts`：内建队列、`replayEffects`、回帖入队、关停不误标 failed、`stop` 收队列
- [x] `src/index.ts`：启动时重放未完成动作
- [x] `tests/effects.test.ts`：去重、复用、退避阶梯、重启重放、关停
- [x] `tests/github-comments.test.ts`：交付器用例经真实队列，失败用例注入零等待
- [x] `docs/specs/014-outbox-effects/`：spec / plan / tasks
- [x] 验证：`bun test`、`bunx tsc --noEmit`
