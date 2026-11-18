# 018 · 任务清单

- [x] T1 规格：`docs/specs/018-mgmt-api/spec.md`、`plan.md`、`tasks.md`
- [x] T2 `src/status.ts`：`BoardView`、`executorState`、`formatBoard`，`formatStatusBoard` 输出不变
- [x] T3 `src/router.ts`：`fill()` 尊重 `executor.paused`
- [x] T4 `src/web.ts`：新路由、错误 `reason`、暂停/重试/停止/撤销/续跑/日志接口、API 拒绝 query token
- [x] T5 `src/cli.ts`：HTTP 客户端与 0/1/2/3 退出码
- [x] T6 `src/web-ui.ts`：新路径与字段
- [x] T7 测试：`tests/web.test.ts`、`tests/cli.test.ts`
- [x] T8 文档：`docs/operations.md`、`README.md`、`skills/pisa/`
- [x] T9 验证：`bun test`、`bunx tsc --noEmit`
