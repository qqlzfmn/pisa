# 005 · 任务拆分

- [x] T1 状态机新增 `paused` 与跃迁 (FR-001)
      验证: `bun test tests/router.test.ts`（状态机 3 例）
- [x] T2 适配器 `resumeSessionId` → `-r <id>` + 提示词恢复段 (FR-006)
      验证: `bun test tests/adapter.test.ts`（2 例，含参数顺序）
- [x] T3 `Router.recoverInterrupted()` 分流，`index.ts` 启动调用 (FR-002)
      验证: 「启动恢复：可恢复的转 paused，其余 failed，工作副本保留」
- [x] T4 `/pisa resume` 与私聊 `/resume`，校验与回执 (FR-003/004/007)
      验证: 「resume 拒绝未中断、非本人、无工作副本的请求」
- [x] T5 `runTask` 复用已有工作副本，Worker 带会话恢复 (FR-005/008)
      验证: 「resume 复用工作副本，Worker 再次执行且任务成功」
- [x] T6 `cancel` 接受 `paused` (FR-001)
      验证: 「paused 的任务可以取消」
- [x] T7 文档：README 用法、001/002/003 指向新行为
      验证: 人工检查，无 `markOrphansFailed` 残留引用
- [x] T8 全量验收：`bun test`（37 通过）+ `tsc --noEmit`（无输出）
