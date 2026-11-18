# 022 · 任务清单

每个任务挂验证点；按顺序执行，前一项的红相测试先于实现写出。

- [x] T001 新增 `src/slots.ts`：`HUMAN_SLOTS`、`slotLimits`、`slotUsage`、`slotText`、`queueReason`
  - 验证：`tests/slots.test.ts` 覆盖用量拆分（运行数 <、=、> 工作槽）、文案、两个 `priority` 在满/未满时的返回值
- [x] T002 `Task.priority` 落库：`src/types.ts` 加 `TaskPriority`，`src/store.ts` 加列与迁移、`Row`/`toTask`/`insertTask` 同步、`nextQueued(priority?)` 支持过滤
  - 验证：旧库补列后可读；`nextQueued("human")` 只返回 `human`，无参仍是全局最早
- [x] T003 `Router.fill()` 按槽位补位：工作槽有空位时按创建时间先来后到，占满后只有 `human` 能进追问槽；`handle()` 把 `continue` / `continueFrom` 建的任务标为 `human`
  - 验证：`tests/router.test.ts` 满槽时 `continue` 立刻运行、新任务仍排队
- [x] T004 `Router.handleResume()` 上限改为工作槽 + 追问槽，回执带槽位用量
  - 验证：工作槽满、追问槽空时可 `resume`；两槽都满时任务保持 `paused`
- [x] T005 `src/status.ts` 看板：首行槽位用量，排队行追加排队原因；`formatStatusBoard(store, limits, now?)`
  - 验证：`tests/router.test.ts` 看板断言含 `槽位：工作 1/1 · 追问 +0/1` 与「排队原因：追问槽位已满」
- [x] T006 `src/cli.ts`：`newCliTask` 带 `priority`（`task`→`auto`、`continue`→`human`），`status` 传槽位上限
  - 验证：`tests/cli.test.ts` 既有断言不破；新增 `pisa continue` 建出的任务 `priority = human`
- [x] T007 文档：本目录 `spec.md`、`docs/architecture.md` 调度与并发段、`docs/usage.md` 并发段、`CHANGELOG.md`
  - 验证：`bun test tests/docs-links.test.ts` 通过
- [ ] T008 收尾：`bun test`、`bunx tsc --noEmit`
