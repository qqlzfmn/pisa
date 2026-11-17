# 012 · 任务

- [x] `src/config.ts`：`COMMANDS` / `BOT_COMMANDS`、`parseCommand` 查表、`taskGuard` + Levenshtein
- [x] `src/router.ts`：`task` 前置防护、待确认状态、`confirm` 分支、私聊错拼建议
- [x] `src/types.ts` + `src/channels/telegram.ts` + `src/index.ts`：`setCommands` 与启动注册
- [x] `tests/router.test.ts`：stats→status、refactor→确认、中文直通、私聊 `/stats`
- [x] `tests/telegram.test.ts`：`setMyCommands` 载荷
- [x] `README.md`：命令说明补充误触防护与确认
- [x] 验证：`bun test`、`bunx tsc --noEmit`
