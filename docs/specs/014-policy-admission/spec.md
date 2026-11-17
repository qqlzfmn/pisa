# 014 · 来源准入策略

- 状态：implemented
- 关联：001（Router 建任务入口）、005（中断与恢复）、006（GitHub 评论投递身份）、009（cron）、011（多仓库评论）
- 依赖：无新增依赖

## 1. 问题

现在只有一份 `whitelist.users`，所有入口共用：

- IM、webhook、GitHub 评论、cron、proactive 的信任级别不同，无法分别开关，也无法规定「名单外的人 @ 机器人时只观察不执行」。
- GitHub 评论的作者被丢弃，统一按配置里的 `userId` 投递；补评论鉴权只能补一个点，管不了其它来源。
- 配置改了以后，已经存在的任务不知道自己当初是按哪条规则进来的，也无法判断恢复时权限是否还成立。
- `resume` 只检查请求者身份，不重新校验来源与准入单元；降权后仍可恢复旧任务。

## 2. 目标

- 每个来源有独立的 `allowed` 开关和四格准入表（名单内/外 × 是否 @），每格取 `off` / `observe` / `auto`。
- 默认策略与现状一致：白名单用户发起即执行，名单外一律拒绝；不配置 `policy` 时行为不变。
- 建任务时把 `mandate`（来源、名单内外、是否 @、模式、通道）与 `policyVersion` 落库。
- 恢复前按当前策略重新校验；不再满足 `auto` 时拒绝并说明原因，任务保持暂停。
- `/pisa policy` 展示当前生效规则与版本号。
- 策略变更不回溯改写既有任务；只影响新请求与恢复。

## 3. 用户故事

### US-1 来源分权

作为运维者，我把 `webhook` 保持 `auto`，把 `im` 的「名单外 + @」设为 `observe`。陌生人 @ 机器人时只收到「已记录、不执行」，不会建任务。

### US-2 降权可追溯

作为运维者，我把某人移出白名单后，他此前的任务仍能查询；但他再发新需求会被拒绝，恢复旧任务也会被拒绝，并看到当前策略版本与拒绝原因。

### US-3 恢复前重校验

作为任务发起者，我执行 `/pisa resume <任务号>`。若这条任务当初靠「名单外 + @ = auto」进来，而该格已改成 `off`，pisa 拒绝恢复并保留工作副本。

### US-4 查看规则

作为运维者，我在任意聊天里发 `/pisa policy`，得到策略版本与五个来源的 `allowed`、四格模式。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 配置新增可选段 `policy.sources.<来源>.allowed`（缺省 `true`）与 `admission`：准入单元数组，每项 `{ listed: boolean, mentioned: boolean, mode: "off" \| "observe" \| "auto" }`。配置了 `admission` 时可只给部分格，缺的格按 `off` 处理；重复格、未知字段、类型不符（如 `allowed: null`）与未知来源均为配置错误，启动即失败，不静默落回默认表 |
| FR-002 | 来源固定为 `im`、`github`、`webhook`、`cron`、`proactive`。`channel` 精确匹配同名来源，其余通道（`telegram`、`cli` 与测试通道）归入 `im`；proactive 关键词沿用原通道，探针使用 `proactive` |
| FR-003 | 默认准入表：名单内（无论是否 @）为 `auto`，名单外（无论是否 @）为 `off`；所有来源 `allowed` 为 `true`。不配置 `policy` 时与旧行为一致：白名单用户发起即执行，名单外拒绝 |
| FR-004 | 策略版本由生效策略内容计算；配置写了 `policy.version` 时直接使用该值。生效策略任一字段变化都会改变默认版本号 |
| FR-005 | 建任务前做准入判定：`off` 回复拒绝原因且不建任务；`observe` 回复「已记录、不执行」且不建任务；`auto` 才继续仓库校验并建任务 |
| FR-006 | `IncomingMessage` 增加可选 `mentioned`：`true` 表示这条消息明确要求 pisa 做事；缺省视为 `true`。Telegram 私聊为 `true`，群聊用 `getMe` 得到的 bot 用户名精确匹配 `@username`；启动链上的 Telegram 调用（`getMe`、`setMyCommands`）都限时 8 秒，失败只告警不阻断启动，拿不到用户名时群聊按未 @ 处理，名单外无法借此进入。webhook、cron、GitHub 命令、CLI 与测试通道不设置，按显式请求处理 |
| FR-007 | 任务新增 `mandate`（`source`、`channel`、`listed`、`mentioned`、`mode`）与 `policyVersion`；新增列并做轻量迁移。旧任务两列为 `null` |
| FR-008 | `resume` 在身份、状态、工作副本校验之后重新判定：用任务记录的 `source` 与 `mentioned`、当前白名单计算 `listed`；结果不是 `auto` 时拒绝，回复当前 `policyVersion` 与原因，任务保持 `paused`。旧任务无 `mandate` 时按 `channel` 推导来源、`mentioned = true` 参与校验 |
| FR-009 | 新增命令 `policy`（中文别名「策略」，进菜单、私聊可用 `/policy`），输出策略版本与每个来源的 `allowed` 和四格模式 |
| FR-010 | 仓库白名单与 git 仓库校验保持不变；准入只决定「谁能派活」，不放宽仓库范围。拒绝提示仍含「无权限」并保留 24h 节流 |

## 5. 验收

1. 不配置 `policy` 时，白名单用户发需求照常建任务；名单外用户被拒，回复含「无权限」
2. 把 `im` 的「名单外 + @」设为 `observe` 后，名单外用户 @ 发需求：不建任务，回复含 `observe` 与「不执行」
3. 把同一格设为 `auto` 后，名单外用户可建任务，任务的 `mandate.listed = false`、`mandate.mode = "auto"`，`policyVersion` 与 `/pisa policy` 一致
4. 白名单用户建任务后被移出白名单：新需求被拒；既有任务不受影响；`resume` 被拒并回复当前策略版本与原因，状态仍为 `paused`
5. `/pisa policy` 输出五个来源、`allowed`、四格模式与版本号；修改任一格后版本号变化
6. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 策略变更时中止正在运行的任务：只影响新请求与恢复
- 按仓库或按聊天细分的准入：仓库仍由 `whitelist.repos` 控制
- 保存每次 `observe` / 拒绝的判定流水：任务只记录被接受时的 `mandate`
- GitHub 评论作者身份识别：评论仍以配置的 `userId` 投递，未改变该前提
- `observe` 模式执行 agent：只记录并回复，不创建任务、不跑代码
