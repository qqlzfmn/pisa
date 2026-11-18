# 022 · 任务清单

- [x] T001 写 `docs/specs/022-prompt-layers/spec.md` 与 `plan.md`（FR-001…FR-008）
- [x] T002 建 `prompts/worker/` 与 `prompts/review/`：`prompt.json` 带 `version` 与段落清单，正文从现有代码原样迁出（NFR-001）
- [x] T003 实现 `src/prompts.ts`：清单/正文读取、`PROMPT_VARS` 校验、内置 + 团队合并、`render`、`PromptConfigError`（FR-001…FR-007）
- [x] T004 `src/prompts.ts` 文案：`formatPromptList` / `formatPromptSections` / `formatPromptDiff` / `formatPromptsCommand`（FR-008）
- [x] T005 接入适配器：`OmpAdapter` 持有 `PromptSet`，删除 `buildPrompt`；`getAdapter(name, prompts?)`
- [x] T006 接入 Worker：构造参数 `prompts`；`GithubWatcher` 与 `buildReviewPrompt` 接收 `PromptSet`
- [x] T007 配置：`prompts.dir`（相对配置文件目录解析）；`COMMANDS` 增加 `prompts`（FR-007、FR-008）
- [x] T008 Router 处理 `prompts` 命令；`src/index.ts` 启动加载并注入、打印版本摘要（FR-005、NFR-002）
- [x] T009 测试：`tests/prompts.test.ts`（组合顺序、回退默认、非法配置、diff）+ `tests/router.test.ts` 命令回执
- [x] T010 文档：`docs/operations.md` 提示词覆盖一节与命令表、`docs/architecture.md` 索引、`pisa.config.example.json`、`CHANGELOG.md`
- [x] T011 验证：`bun test`、`bunx tsc --noEmit`、CLI 通道 smoke

验证命令：

```
bun test
bunx tsc --noEmit
printf '/pisa prompts\n/pisa prompts review diff\n' | PISA_STATE_DIR=/tmp/pisa-smoke bun run src/index.ts --channel cli
```
