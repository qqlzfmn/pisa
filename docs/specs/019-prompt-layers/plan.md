# 019 · 实现计划

## D1 段落清单与内置文本放在 `src/prompts.ts`

段落是有序数组 `PROMPT_SECTIONS`，每项含 `key`、允许的模板变量与内置文本。顺序即拼接顺序；键是封闭联合类型，编译期与运行期共用一份清单。

内置文本逐字保留改造前 `buildPrompt()` 的内容，段落间用 `\n\n` 拼接，输出与改造前一致（适配器测试沿用原断言）。

## D2 覆盖文件是目录约定，不引入清单文件

- `prompts/VERSION`：正整数，单独一个文件，diff 里一眼能看到版本变化。
- `prompts/<key>.md`、`prompts/repos/<alias>/<key>.md`：文件名即键名。
- 扫描目录时不认识的 `.md`、子目录、空文件、非法占位符都报错；不做「猜测式忽略」，避免拼错键名后静默使用内置。

`loadPrompts` 接收仓库别名列表，`repos/` 下出现未配置的别名就报错——覆盖文件写错仓库同样应该拒绝启动。

## D3 模板变量按段声明

每段只允许自己的变量（`worker.intro` → `taskId`，`worker.context` → `context`，`worker.task` → `prompt`，另两段无变量）。加载时校验，渲染时只替换已知变量；未知变量保留原文也不可能出现，因为启动已拒绝。

## D4 覆盖优先级在 `resolvePrompt` 一处实现

仓库层命中 → 团队层命中 → 内置。`buildWorkerPrompt` 只按顺序取段落并替换变量，不关心来源。`/pisa prompts` 用同一个 `resolvePrompt`，展示与执行不会出现两套优先级。

## D5 版本与 diff

`/pisa prompts` 展示 `提示词 v<version>`、团队/仓库覆盖计数、每段来源与覆盖目录。`/pisa prompts diff` 对每个生效文本不等于内置的段落输出行级 unified diff（3 行上下文，LCS 实现；段落很短，不值得引依赖）。`@仓库` 参数让同一套命令能检查仓库层覆盖。

## D6 装配与失败时机

`loadPrompts` 在 `src/index.ts` 启动时调用一次，目录与别名来自 `loadConfig()` 的结果；失败打印 `[pisa] 提示词配置错误：…` 并退出 1。加载结果同时交给 `Worker` 与 `Router`，命令展示与实际提示词共用同一对象，不存在两份缓存。

不放在 `loadConfig()` 里的原因：配置模块只做浅合并与路径解析，测试大量手工构造 `Config`；提示词校验依赖仓库别名且应当只发生一次，放在装配点更清楚。

## D7 测试

- `tests/prompts.test.ts`：拼接顺序、恢复/上下文省略、无目录回退、团队替换、仓库优先、未知键/别名/版本/空文件/变量、查看与 diff。
- `tests/adapter.test.ts`：仓库覆盖进入 `-p` 参数；原有恢复段断言不改，证明默认输出未变。
- `tests/router.test.ts`：`/pisa prompts`、`/pisa prompts diff`、未知仓库别名。
