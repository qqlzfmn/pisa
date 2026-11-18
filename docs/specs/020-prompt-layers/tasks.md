# 020 · 任务

- [x] 建立 `prompts/` 清单与内置段落
- [x] `src/prompts.ts`：加载、校验、覆盖解析、渲染、列表、diff
- [x] `buildPrompt` 改为按固定顺序拼装段落
- [x] `Worker`、`AdapterInput` 注入 `PromptLibrary`
- [x] 配置 `prompts.dir`，解析相对配置文件路径
- [x] `/pisa prompts` 与 `/pisa prompts diff [键]`，命令清单与帮助同步
- [x] 主动发现默认提示词改读内置段落
- [x] 启动加载，失败打印原因并退出
- [x] `tests/prompts.test.ts` 与路由命令测试
- [x] 更新 `docs/operations.md`、`pisa.config.example.json`、`CHANGELOG.md`
- [x] `bun test`、`bunx tsc --noEmit`
