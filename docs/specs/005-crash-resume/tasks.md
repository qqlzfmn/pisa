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
- [x] T9 关停语义：`stopping` 标记、`runTask` 早退、退出码 75 (spec §7)
      验证: 「关停中 Worker 完成后任务保持 running，工作副本与分支保留」「stop() 之后不再调度新任务」
- [x] T10 恢复核对提示：目录与 git 历史、PR 存在性、外部动作去重；`resume` 标记独立于会话 id (FR-006)
      验证: 「恢复提示要求先核对目录、git 历史与 PR，再决定外部动作」「恢复标记与是否有会话 id 无关」
- [x] T11 重启分流优先尊重 `cancel_requested`：取消否决不被改写成 `paused` (FR-002)
      验证: 「启动恢复：已请求取消的任务直接取消，不被恢复成 paused」
