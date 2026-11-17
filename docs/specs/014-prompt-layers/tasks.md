# 014 · 任务

- [x] `prompts/builtin.json`：内置段落 + `version`
- [x] `src/prompts.ts`：段落常量、装载校验、装配回退、渲染、diff、摘要
- [x] `src/adapters/*`：`AdapterInput.prompts`，删除写死的 `buildPrompt`
- [x] `src/worker.ts`：注入 `PromptSet`
- [x] `src/config.ts`：`prompts` 命令（别名、菜单、带参数）
- [x] `src/router.ts`：`/pisa prompts`、`/pisa prompts diff`、帮助与私聊映射
- [x] `src/index.ts`：启动装载，配置错误直接退出
- [x] `tests/prompts.test.ts` + `tests/adapter.test.ts` + `tests/router.test.ts` 及其余 Router 构造点
- [x] `README.md`：提示词分层用法
- [x] 验证：`bun test`、`bunx tsc --noEmit`
