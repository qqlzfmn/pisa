# 022 · 实现计划

## 决策

### D1 目录布局：每个提示词一个目录

`prompts/<id>/prompt.json` + `<key>.md`。

- `prompt.json`：`{ "version": number, "sections": [{ "key": string, "when"?: string }] }`
- 段落正文在 `<key>.md`；`key` 即文件名，无正文格式解析，避免在 Markdown 里自造分隔符
- 理由：段落可独立覆盖（FR-004）、顺序由清单决定（FR-001），文件即单元，diff 与评审都直观

团队层（`prompts.dir`）用同样布局：`<team>/<id>/prompt.json` 只需 `version` 与新增段落声明；同名 `<key>.md` 覆盖内置。

### D2 变量与条件由代码声明

`src/prompts.ts` 维护 `PROMPT_VARS`：每个 id 允许的模板变量（worker：`taskId`、`prompt`、`context`、`resume`；review：`repo`、`number`、`title`、`baseRefName`、`head`、`headSha`、`url`、`diff`）。`when` 只能取本 id 的变量名。理由：变量是调用方代码给的，文案是数据；把变量名也放数据会失去编译期校验，且没有可变性需求。

### D3 加载与合并

`loadPromptSet({ builtinDir?, teamDir? })` 返回 `PromptSet`（`ids`、`get`、`render`、`teamDir`、`teamActive`）。

- 内置目录的每个子目录必须对应 `PROMPT_VARS` 里的 id，否则拒绝（防止数据与代码变量表分叉）
- 团队目录不存在 → 仅内置（FR-005）；存在则逐个 id 合并，未列出的 id 保持内置
- 合并顺序：内置清单顺序，再接团队清单新增段落（FR-004）
- 覆盖段记下内置原文，供 diff 使用

### D4 注入点

- `Worker` 构造第三个参数 `prompts: PromptSet`（默认 `defaultPromptSet()`，即内置，测试与旧调用不受影响），传到 `getAdapter(cfg.adapter, prompts)`
- `OmpAdapter` 用 `prompts.render("worker", vars)` 生成 `-p` 正文；删除写死的 `buildPrompt`（含 `src/adapters/index.ts` 的再导出）
- `buildReviewPrompt(prompts, repo, pr, diff)` 接收 PromptSet；`GithubWatcher` 依赖新增 `prompts?`
- `Router` 依赖新增 `prompts?`，处理 `prompts` 命令
- `src/index.ts` 启动时 `loadProjectPrompts(cfg)`，失败打印错误并 `exit(1)`，成功把同一个 `PromptSet` 交给 Worker、Router、GithubWatcher，并打印一行版本摘要

### D5 命令

`COMMANDS` 增加 `{ command: "prompts", alias: "提示词", group: "查询", args: "[<提示词> [diff]]", menu: true }`；文案生成在 `src/prompts.ts`，帮助表由 `formatHelp` 自动覆盖。

### D6 测试

- `tests/prompts.test.ts`：用临时目录造内置/团队层（不经真实 `prompts/`），覆盖组合顺序、覆盖替换、回退默认、六类非法配置、渲染变量、diff 文案
- 真实 `prompts/` 目录的忠实性由 adapter 测试与 review 测试的既有断言间接保证
- `tests/router.test.ts` 增加 `/pisa prompts` 三个形态的回执测试
- 端到端 smoke：`PISA_STATE_DIR=/tmp/... bun run src/index.ts --channel cli`，stdin 喂 `/pisa prompts` 与 `/pisa prompts worker diff`

## 影响面

- `src/adapters/omp.ts` 失去提示词正文；`buildArgs` 依赖 `PromptSet`，默认参数保证 `getAdapter()` 单参调用不变
- 新增 `prompts/` 参与打包与发布（仓库根目录，随代码走）
- `AdapterInput` 不变
