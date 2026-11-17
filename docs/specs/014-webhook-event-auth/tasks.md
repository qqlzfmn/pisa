# 014 · 任务

- [x] T001 `tests/router.test.ts`：被拒投递不占用 `eventId`；同 `eventId` 重复投递只建一个任务（FR-001）
      验证：`bun test tests/router.test.ts` → 红相 1 fail，实现后通过
- [x] T002 `tests/webhook.test.ts`：`eventId` 前缀校验、自动生成、token 比较、体积上限（FR-002/003/004）
      验证：`bun test tests/webhook.test.ts` → 9 pass
- [x] T003 `src/webhook.ts`：`webhookHandler` 依赖注入实现，`src/index.ts` 改用它（FR-002/003/004）
      验证：`bunx tsc --noEmit` 无错误
- [x] T004 `src/router.ts`：`claimEvent` 移到鉴权与 prompt 校验之后（FR-001）
      验证：`bun test tests/router.test.ts`
- [x] T005 `README.md` 与 `docs/specs/003-super-agent-loop/spec.md`：示例改为 `webhook:` 前缀并注明规则（FR-005）
      验证：人工核对
- [x] T006 全量验证：`bun test`（142 pass）、`bunx tsc --noEmit`（0 错误）；本地起服务冒烟：错误 token 403、`cron:` 前缀 400、合法事件 200 且重复只建 1 个任务、70 KB 请求 413
