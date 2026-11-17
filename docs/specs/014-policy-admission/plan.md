# 014 · 实现计划

- 输入：`spec.md`
- 约束：无新增依赖；不改 extension；不改变未配置 `policy` 时的行为

## 1. 技术决策

| 决策 | 结论 | 依据 |
| --- | --- | --- |
| 模块划分 | 新增 `src/policy.ts`：类型、默认表、`effectivePolicy`、`decide`、`sourceOf`；`config.ts` 只持有 `policy?` 字段；`types.ts` 与 `router.ts` 只消费 | 判定逻辑是纯函数，可单测；避免把策略规则散在 Router（FR-001/003/004） |
| 配置形状 | `policy.sources.<来源>` 可部分覆盖；`admission` 是数组而非固定字段 | 数组能直接表达「四格」，缺格与重复格校验简单；来源内只覆盖需要的字段（FR-001） |
| 默认值 | 默认表：名单内两格 `auto`，名单外两格 `off`；`allowed` 缺省 `true` | 与现状一致：白名单用户发起即执行、不要求 @；名单外拒绝（FR-003） |
| 版本 | 默认 `p-<sha256 前 8 位>`，哈希输入为固定顺序的 `{source, allowed, admission}`；显式 `policy.version` 优先 | 无需手工 bump；显式版本用于运维固定标记（FR-004） |
| 来源映射 | `sourceOf(channel)`：同名五来源精确匹配，其余归 `im` | 现有多数通道是 IM 或测试替身；proactive 关键词保留原通道（FR-002） |
| 未 @ 检测 | `IncomingMessage.mentioned?: boolean`，缺省 `true`；Telegram 私有 `getMe` 后匹配 `@username` | 不让 Router 猜测通道语义；`@family` 仓库前缀不会被误判为点名（FR-006） |
| 准入位置 | `Router.handle` 在 `claimEvent` 之后、仓库校验之前判定 | 去重先占键，避免重复回复；授权先于仓库信息（FR-005） |
| 白名单拆分 | 准入判定取代 `checkAccess` 中的用户白名单检查；`checkAccess` 只保留仓库白名单与 git 校验 | 否则「名单外 + @ = auto」永远过不了旧检查（FR-010） |
| 观察 | `observe` 只回复并结束，不建任务、不跑 worker | 语义最小且安全；任务只记录被接受的 `mandate`（FR-005） |
| 存储 | `tasks` 新增 `mandate TEXT`、`policy_version TEXT`，启动时按 `PRAGMA table_info` 补列；`mandate` 存 JSON | 与既有轻量迁移一致；任务不参与策略回溯，字段只在插入时写（FR-007） |
| 恢复校验 | 新增 `admitResume(task)`：无 `mandate` 时按 `channel` 推导、`mentioned = true`；有 `mandate` 时用记录的 `source` / `mentioned` 与当前白名单 | 旧任务不绕过校验；`listed` 用当前名单，才能捕获降权（FR-008） |
| 命令 | `policy` 进 `COMMANDS`、菜单与帮助；私聊映射 `/policy`、「策略」 | 与现有命令同一事实源（FR-009） |

## 2. 影响面

- `src/policy.ts`（新）：策略类型、默认表、`effectivePolicy`、`decide`、`sourceOf`
- `src/config.ts`：`Config.policy?`、`merge` 深合并、`policy` 命令与私聊别名
- `src/types.ts`：`IncomingMessage.mentioned?`、`Mandate`、`Task.mandate` / `Task.policyVersion`
- `src/store.ts`：两列、迁移、`toTask` 解析、`insertTask` 写入
- `src/router.ts`：准入判定、`mandate` 落库、`checkAccess` 拆分、`handleResume` 重校验、`/pisa policy` 与帮助
- `src/channels/telegram.ts`：`getMe`、`mentionsBot`
- `tests/policy.test.ts`（新）、`tests/telegram.test.ts`、现有任务字面量
- `pisa.config.example.json`、`README.md`

## 3. 测试策略

- 纯函数：默认表、版本稳定性与变更、显式版本、四格判定、来源映射
- Router：默认策略下行为不变；名单外被拒；`observe` 不建任务；`auto` 建任务且 `mandate` / `policyVersion` 正确；名单内外 × 是否 @ 的默认格
- 降权：移除白名单后新请求被拒，既有任务保持原状
- 恢复：有 `mandate` 的任务在策略降为 `off` 后拒绝恢复并保持 `paused`；旧任务（无 `mandate`）仍可恢复
- 命令：`/pisa policy` 输出版本与五来源；Telegram 菜单加入 `policy`
- Telegram：`mentionsBot` 精确匹配，不把 `@family` 当点名

## 4. 风险

- 默认 `mentioned = true`：新通道如果不设置该字段，会按「已 @」处理。这是保持旧行为的保守选择；需要区分未 @ 的通道必须显式设置
- 显式 `policy.version` 不随内容变化：运维固定版本号时可能掩盖配置漂移。规格已说明，默认哈希版本不会出现该问题
- 旧任务无 `mandate` 的恢复使用推导值；若原通道不在五来源内会归入 `im`，与旧行为一致
