# 017 · 实施计划

## D1 准入收敛到纯模块 `src/policy.ts`

类型：`AcceptMode`、`Audience`、`Addressing`、`CellRule`、`AdmissionCells`、`SourcePolicy`、`PolicyConfig`、`Mandate`。

纯函数：

- `sourcePolicy(cfg, source)`：默认值 + 配置深合并；未配置的来源返回默认。
- `admit(host, input)`：一次裁决，返回 `Admission`（含 `reason`，拒绝时带版本）。
- `policyVersion(host)`：对 `{users 排序, repos 排序, 已配置来源的生效策略}` 做键排序的规范序列化后 sha256，取前 12 位。
- `mandateOf(admission, requester, at)`、`formatPolicy(host)`。

理由：裁决、版本、展示三处必须用同一份默认值与同一套字段；散落在 Router 里必然漂移。默认值采用旧白名单语义，升级不改变现有行为。

## D2 Router 接入点：去重之后、仓库校验之前

`handle()` 的建任务路径：

1. `routeByAlias`、回复改写、命令分派保持原样。
2. `claimEvent` 抢占事件（被拒事件同样占键，保持原来「改配置后换 eventId 重投」的语义）。
3. `admit(cfg, {source: msg.channel, requester: msg.userId, addressed: isAddressed(msg)})`；拒绝走原来的 `deniedAt` 24 小时节流；`observe` 且裁决为 `deny` 时 `console.warn`。
4. `checkRepo`（原 `checkAccess` 去掉用户白名单一项）：仓库未配置、仓库不在白名单、目录不是 git 仓库。
5. `insertTask` 时写 `mandate: mandateOf(admission, msg.userId, now)`。

`isAddressed`：显式 `addressed` 优先；否则 `isDirect || admin || replyToMessageId || 文本以触发词开头 || 文本以 / 开头`。续跑改写会在文本前拼触发词，因此续跑恒为点名；关键词派活在 `proactive.ts` 显式 `addressed:false`。

## D3 存储：mandate 列

`tasks` 加 `mandate TEXT`；`Row.mandate`；`parseMandate` 容错解析（脏数据退化为 `null`，不拖垮看板）；`insertTask` 写 JSON；迁移用 `PRAGMA table_info` 检查后 `ALTER TABLE`。mandate 一经写入不再更新，`transition` 不触碰它。

## D4 resume 重校验

`handleResume` 在「必须是 paused」「原请求者/admin」之后、worktree 检查之前：

- 用 `task.mandate` 的 `source` 与 `addressing` 重跑 `admit`；旧任务 `mandate=null` 时按 `channel` + `addressed=true`。
- 失败回复 `恢复被拒 · <id>`、admission 原因、「任务准入版本 x，当前策略版本 y」，不改变状态。
- 再校验 `whitelist.repos`，同样拒绝并给出两个版本。

不追溯：`queued` 任务由 `fill` 直接启动，不重跑准入；只有人工 `resume` 触发重校验。

## D5 命令与展示

`COMMANDS` 增加 `policy`（别名 `准入`，进菜单），`CommandKind` 同步；`handle` 在 `status` 旁加分支回 `formatPolicy(cfg)`；私聊免触发词分支识别 `/policy` 与 `准入`。

`formatPolicy` 输出：版本、判断顺序、不追溯/重校验说明、两份名单；未配置来源时打印默认四格；有配置时按来源打印开关、模式与四格。

## 验证

- `tests/policy.test.ts`：默认四格、按来源覆盖、off/observe/auto、版本稳定性与敏感性、formatPolicy 文案
- `tests/router.test.ts`：mandate 与版本落库、名单外拒绝带版本、未点名可配置放行、off 全拒、observe 放行并告警、不追溯已排队任务、降权后 resume 被拒（保持 paused、版本差）、仓库移出白名单后 resume 被拒、`/pisa policy` 与私聊 `/policy`
- `tests/telegram.test.ts`：菜单注册包含 `policy`
- `bun test`、`bunx tsc --noEmit`
