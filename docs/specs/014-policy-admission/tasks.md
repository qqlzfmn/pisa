# 014 · 任务清单

- [x] T1 规格与计划：`spec.md`、`plan.md`
- [x] T2 策略模块：类型、默认表、`effectivePolicy`、`decide`、`sourceOf`（FR-001~004）
- [x] T3 配置与命令：`policy` 字段、`policy` 命令、私聊别名、帮助与菜单（FR-009）
- [x] T4 任务模型与存储：`mentioned`、`Mandate`、`mandate` / `policyVersion` 列与迁移（FR-006/007）
- [x] T5 Router 准入：off / observe / auto 判定、拒绝节流、`mandate` 落库（FR-005/010）
- [x] T6 恢复重校验：`admitResume`，拒绝时保持暂停并说明（FR-008）
- [x] T7 Telegram：`getMe`、`mentionsBot`、群聊 @ 判定（FR-006）
- [x] T8 测试：策略纯函数、越权、observe、auto、降权、恢复被拒、策略命令、mention 匹配
- [x] T9 文档：README 准入策略、示例配置
- [x] T10 验证：`bun test`、`bunx tsc --noEmit`
