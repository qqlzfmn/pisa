# 008 · 实现计划

## 决策

### D1 前缀解析放在 `src/config.ts`

新增纯函数 `splitRepoAlias(text, repos)`，与 `parseCommand`、`repoByAlias` 同处配置解析层。理由：路由前缀是入口语法，不属于调度；纯函数便于单测，Router 只负责应用结果 (FR-001/FR-003)。

### D2 Router 在 `handle` 最前面归一化消息

在回复续跑判断之前调用一次 `routeByAlias`：命中别名时返回改写后的消息（仓库 + 正文），后续所有分支（续跑、命令、私聊免触发词）都自然使用新仓库与正文 (FR-001/FR-002/FR-007)。

触发词形式不单独写解析器：若整条文本以触发词开头，去掉触发词后再尝试同一个 `splitRepoAlias`，命中则用 `<触发词> <剩余正文>` 重组文本，交给原有 `parseCommand`。因此不需要在 `parseCommand` 里感知仓库 (FR-002)。

### D3 别名不存在不改写

`splitRepoAlias` 只在别名于 `repos` 中精确存在时返回结果，其余返回 `null`；调用方保持原消息。默认仓库逻辑仍在原来的 `repoByAlias(cfg, msg.repo ?? cfg.repos[0]?.alias)` (FR-003)。

### D4 回执与帮助文本

接单消息由单行改成三行：`已接单 · <任务号>` / `仓库：<别名>` / `排队中。` (FR-004)。帮助列表加一行 `<触发词> @别名 <需求>` (FR-005)。

## 测试策略

- `tests/router.test.ts` 新增 `describe("多仓库路由")`：双仓库配置（`demo` 默认、`family` 第二），复用现有 FakeChannel 与 `Router.handle`，断言 `store.recent()[0]` 的 `repo` 与 `prompt`，以及回执文本包含 `仓库：family`。
- 覆盖四个场景：触发词 + 别名、私聊裸文本 + 别名、未知别名退回默认、帮助文本含别名语法。
- `bun test` 与 `tsc --noEmit` 全绿。

## 影响面

- `src/config.ts`：新增导出函数
- `src/router.ts`：`handle` 入口归一化、回执、帮助
- `tests/router.test.ts`：新增用例
- `README.md`：新增「多仓库」小节
- `pisa.config.example.json`：无结构变化，示例保持即可
