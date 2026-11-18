# 020 · 任务拆分

## T1 投影与日志尾部

- `src/status.ts`：`BoardView`、`boardView(store, now, limits)`、`formatBoard(view)`；`formatStatusBoard` 改为组合；删除 `StatusSnapshot` / `statusSnapshot`
- `src/log.ts`：新增 `taskLogTail(stateDir, id, count)`，从 `web.ts` 挪入
- `src/http.ts`：导出 `json(value, status, headers)`

验证：`bun test tests/status.test.ts`（若有）与 `bunx tsc --noEmit`

## T2 Router 能力

- `pauseExecutor` / `executorState` / `paused`；`fill()` 尊重暂停
- `retryTask(taskId, requester)`；`checkAccess` 改为 `(userId, alias, repo)`
- `src/task-context.ts`：`retryContext(parent)`

验证：`bun test tests/router.test.ts`

## T3 管理接口

- `src/mgmt.ts`：路径匹配、header 鉴权、回环 Host 校验、九个路由、token 读写
- `src/web.ts`：`WebRouter` 扩展、管理路径分派、`startWebServer` 写 `mgmt.token`、`/api/tasks` 详情改用 `taskLogTail`

验证：`bun test tests/mgmt.test.ts`

（T1–T4 已随 `bun test` 350 通过、`bunx tsc --noEmit` 无错完成）

## T4 CLI

- `src/cli.ts` 重写：`openClient`、`call`、命令、退出码映射、帮助文本

验证：`bun test tests/cli.test.ts`

## T5 文档

- 更新 `docs/specs/017-task-stages/spec.md` 中「没有 /state 路由」的说法
- `docs/operations.md`：Agent CLI 一节改为接口客户端，新增「管理 API」路由表
- `skills/pisa/`：`SKILL.md` 与 `references/{commands,failures,limits,scenarios,briefs}.md` 对齐新命令与退出码
- `docs/specs/014-agent-cli/spec.md` 标 superseded
- `CHANGELOG.md` 新增条目

验证：文档 diff 与代码一致

## T6 全量闸门

`bun test`、`bunx tsc --noEmit` 全绿。
