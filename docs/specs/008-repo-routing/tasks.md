# 008 · 任务拆分

- [x] T1 `src/config.ts`：`splitRepoAlias(text, repos)` 精确匹配别名，返回别名与正文 (FR-001/FR-003/FR-006)
      验证: `bun test tests/router.test.ts`（未知别名、多仓库用例）
- [x] T2 `Router.routeByAlias`：入口归一化，支持裸前缀与触发词后前缀 (FR-001/FR-002/FR-007)
      验证: 「触发词后指定仓库，正文去掉别名」「私聊裸文本指定仓库」
- [x] T3 接单回执增加 `仓库：<别名>` (FR-004)
      验证: 「触发词后指定仓库，正文去掉别名」断言回执包含 `仓库：family`
- [x] T4 帮助文本增加 `@别名` 用法 (FR-005)
      验证: 「帮助文本包含别名语法」
- [x] T5 未知别名回退默认仓库且保留原文 (FR-003)
      验证: 「未知别名保持原文并走默认仓库」
- [x] T6 续跑继承父任务仓库，避免别名把续跑带到别的仓库 (FR-007)
      验证: `bun test tests/router.test.ts`；`bun test` 全绿
- [x] T7 README「多仓库」小节与示例配置 (FR-001/FR-004)
      验证: 人工检查 README 正文
- [x] T8 全量校验
      验证: `bun test`、`tsc --noEmit`
