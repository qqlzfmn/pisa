# 014 · 任务

- [x] T001 扩展 `CommandSpec`：增 `args`、`group`，`TAKES_BODY` 由 `args` 派生（FR-001/FR-004）
      验证：`bunx tsc --noEmit`
- [x] T002 新增 `examples` 命令与两个私聊快捷方式（FR-001）
      验证：`parseCommand("/pisa examples")` → `{kind:"examples"}`；`parseCommand("/pisa 示例")` 同
- [x] T003 新建 `src/usage.ts`：分组帮助渲染与 8 个场景（FR-002/003/004）
      验证：`formatHelp` 覆盖 `COMMANDS` 全量；`EXAMPLES` 长度为 8
- [x] T004 路由接线：`help` 走 `formatHelp`，`examples` 回复场景（FR-002/004）
      验证：`/pisa examples` 不建任务；`/pisa help` 含四个分组
- [x] T005 编写 `docs/usage.md` 并在 README 链接（FR-005/006）
      验证：文件存在，README 含链接
- [x] T006 更新既有测试并补新测试（FR-002/003/004）
      验证：`bun test` 全绿
