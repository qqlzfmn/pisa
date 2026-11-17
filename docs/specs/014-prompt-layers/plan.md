# 014 · 实施计划

## D1 段落与拼接顺序是模块常量

`src/prompts.ts` 导出 `SEGMENT_KEYS = ["intro","resume","context","task","constraints"]`，拼接顺序即数组顺序，段间用 `\n\n` 连接。顺序是行为的一部分（角色在最前、约束在最后），写死在单一常量里，覆盖层无法改变顺序，避免团队配置把提示词拼成不可预期的形状。

## D2 内置层落文件，代码只留装载与渲染

`prompts/builtin.json` 是内置段落的唯一事实源，带 `version`。代码里不再有第二份提示词文本，`src/adapters/omp.ts` 的 `buildPrompt` 删除，渲染统一走 `renderPrompt`。

理由：提示词属于内容，不属于代码；两份文本必然漂移。

## D3 团队层是最小覆盖，未覆盖的键回退内置

`prompts/team.json` 的 `segments` 只允许已知键，允许只写一部分。装配时逐键取团队值，缺失则取内置值，同时记录 `sources` 用于展示。团队层不引入「删除段落」语义：删段落会让提示词少一块，风险高于收益；想表达「不要这段」就把该段改成新的措辞。

## D4 启动期严格校验

`loadPrompts(dir)` 在启动时读两个文件并校验：

- 顶层键只能是 `version` / `segments`
- `version` 是正整数
- 段落键必须属于 `SEGMENT_KEYS`，值非空
- 占位符只能是 `{{id}}` / `{{prompt}}` / `{{context}}`
- 内置层必须齐全

任何一条不满足都抛错，`index.ts` 打印后 `process.exit(1)`。不做「跳过坏段落继续跑」：半套提示词比启动失败更难排查。

## D5 PromptSet 由进程装配一次，向下传递

`index.ts` 调 `loadPrompts()` 得到 `PromptSet`，注入 `Router`（`/pisa prompts` 展示用）和 `Worker`（经 `AdapterInput.prompts` 交给适配器）。Router/Worker 不读文件，测试可以直接构造或装载。

## D6 diff 用行级 LCS

`diffLines(before, after)` 是最小 LCS 对齐，输出 `-` / `+` / 空格前缀行。段落都是十几行，二维表足够；引第三方 diff 库不值。

## D7 `/pisa prompts` 走命令清单

`config.ts` 的 `COMMANDS` 加 `prompts`（别名「提示词」，进菜单，`TAKES_BODY`），解析、错拼建议、Telegram 菜单自动带上。Router 分派：空参数给分层摘要，`diff` 给差异，其它参数回用法。

## 验证

- 新增 `tests/prompts.test.ts`：拼接顺序、恢复/上下文条件、无覆盖与改造前逐字节一致、只覆盖一段时其余回退、未知顶层键/未知段落键/缺段落/坏版本/坏占位符/非字符串全部抛错、diff 行、摘要文本
- `tests/adapter.test.ts`：适配器参数里的提示词来自注入的 `PromptSet`
- `tests/router.test.ts`：`/pisa prompts`、`/pisa prompts diff`、非法参数
- `bun test`、`bunx tsc --noEmit`
