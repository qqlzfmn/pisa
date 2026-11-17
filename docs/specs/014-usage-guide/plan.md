# 014 · 实现计划

## 决策

| 决策 | 选择 | 依据 | 需求 |
| --- | --- | --- | --- |
| 命令注册 | 扩展 `COMMANDS`，新增 `examples` | 解析、错拼建议、Telegram 菜单的唯一事实源已存在 | FR-001 |
| 参数与正文 | `CommandSpec.args` 非空即表示接收正文，`TAKES_BODY` 由它派生 | 参数提示与解析规则合成一处，避免两份表漂移 | FR-001 |
| 帮助分组 | `CommandSpec.group` 标记分组，渲染放在新模块 `src/usage.ts` | 命令是否存在归 config，文案归 usage，互不复制 | FR-004 |
| 示例内容 | 结构化数组 `EXAMPLES`，渲染纯函数 `formatExamples()` | 便于测试计数与字段完整性，不把长文本塞进路由 | FR-002/003 |
| 文档 | 新增 `docs/usage.md`，README 用法段落加链接 | 场景长文不进 IM 回复，避免消息超长 | FR-005/006 |

## 模块

- `src/config.ts`：`CommandKind` 增 `examples`；`CommandSpec` 增 `args`、`group`；`COMMANDS` 补条目与分组
- `src/usage.ts`：`HelpGroup` 类型、`EXAMPLES`、`formatExamples(trigger)`、`formatHelp(trigger)`
- `src/router.ts`：`help` 改调 `formatHelp`；新增 `examples` 分支；私聊免触发词快捷方式识别 `/examples`、`示例`
- `docs/usage.md`：场景、最佳实践、能力边界
- `README.md`：用法段落链接

## 测试

- `tests/router.test.ts`：`/pisa examples` 输出场景且不建任务；`/pisa help` 含四个分组且覆盖全部命令
- `tests/config-usage.test.ts`（新增）：`parseCommand` 识别 `examples` 与别名；`formatHelp` 覆盖 `COMMANDS` 全量、每组标题存在；`EXAMPLES` 数量与字段
- `tests/telegram.test.ts`：菜单命令列表加入 `examples`

## 风险

- Telegram 菜单新增一条命令属于可见行为变化；`examples` 与既有命令编辑距离大于 2，不影响误触建议的判定
