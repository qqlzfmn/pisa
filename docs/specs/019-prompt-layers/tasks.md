# 019 · 任务

- [x] T001 新建 `src/prompts.ts`：段落清单、内置文本、`PromptBook`、加载与渲染
  - 验证：`buildWorkerPrompt(BUILTIN_PROMPTS, task)` 与改造前 `buildPrompt` 输出一致
- [x] T002 接入适配器与 Worker：`AdapterInput.prompts`，`Worker` 构造参数
  - 验证：`tests/adapter.test.ts` 原有断言通过；新增仓库覆盖用例
- [x] T003 配置与装配：`promptsDir` 默认配置目录，`src/index.ts` 启动加载，失败退出
  - 验证：`bunx tsc --noEmit`；`loadPrompts` 非法配置用例
- [x] T004 命令：`prompts` 进 `COMMANDS`，`Router` 处理列表、diff、`@仓库`
  - 验证：`tests/router.test.ts` 三条用例
- [x] T005 覆盖目录与版本：`prompts/VERSION`
  - 验证：仓库启动时加载 `prompts/VERSION` 得到 v1、全部内置
- [x] T006 文档：本规格、`docs/architecture.md`、`docs/operations.md`、`CHANGELOG.md`
  - 验证：`bun test tests/docs-links.test.ts tests/architecture-doc.test.ts`
