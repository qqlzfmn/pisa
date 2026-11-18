# 019 · 来源准入表与策略版本

- 状态：implemented
- 关联：003（多来源路由）、007（Web 控制台）、016（流程引擎与插件边界）
- 依赖：无

## 1. 问题

准入只有一处判断：`checkAccess`（`src/router.ts`）看 `whitelist.users` 是否包含 `msg.userId`，所有来源共用同一份用户名单。实际上来源的可信度不同：IM 群里任何人都能发消息；webhook 与本机 Web 控制台用固定 token；GitHub 评论作者完全不受控，任务归属取仓库配置里的身份；定时任务用配置身份开单。名单无法表达「群里的白名单用户可以派活，但只有 @ 机器人才算」「webhook 只记录不派活」「GitHub 来源整体关闭」。

另一个缺口在策略变更：任务落库只记 source/channel/requester，没有任何授权依据与策略版本。改了白名单或来源规则后，正在跑的任务用了哪套策略查不到；`resume` 也不重校验，被移出白名单的身份可以靠恢复旧任务继续驱动 Worker。

复现（改动前）：配置 `whitelist.users = ["u1"]`，创建任务后把 `u1` 从配置移除，再 `/pisa resume <任务号>`：任务照常转 `running` 并执行，没有任何准入检查。

## 2. 目标

- 每个来源可单独配置总闸、名单内是否要求 @、名单外是否在 @ 时放行、接受方式（off / observe / auto）
- 名单内外 × 是否 @ 的组合有确定结果，且能一眼看到（`/pisa policy`）
- 任务记录授权依据（mandate）与策略版本，事后可查「这条任务按哪套策略被准入」
- 恢复前按当前名单与策略重校验，失败给出原因与版本差异
- 策略变更不追溯：排队与运行中的任务不受影响，只有新建与恢复使用新策略
- 不配置 `policy` 时行为与改动前完全一致

## 3. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `policy.sources.<来源>` 接受 `{ allowed?, requireMention?, allowGuests?, accept? }`；缺省 `allowed: true`、`requireMention: false`、`allowGuests: false`、`accept: "auto"`，与改动前一致 |
| FR-002 | `src/policy.ts` 导出 `admit(cfg, { source, requester, mentioned })`：返回 `ok`、`mode`（ok 时为 `off`/`observe`/`auto`）、`reason`、`version`、`listed`、`mentioned` |
| FR-003 | 准入四格：名单内 × @ 允许；名单内 × 不 @ 由 `requireMention` 决定；名单外 × @ 由 `allowGuests` 决定；名单外 × 不 @ 一律拒绝。`allowed: false` 与 `accept: "off"` 拒绝该来源全部请求 |
| FR-004 | `accept: "observe"` 不建任务：写 `admissions` 表并回执一次；同一消息重复投递只记一条 |
| FR-005 | 被拒的投递不写触发器、不占 `eventId`；拒绝提示带「无权限：」前缀并说明命中的哪条规则 |
| FR-006 | 任务记录 `mandate`（`source` / `requester` / `actor` / `mentioned`）与 `policyVersion`；`policyVersion` 取显式 `policy.version`，未配置时取规则指纹（白名单 + 各来源规则） |
| FR-007 | `/pisa policy`（别名 `策略`）列出每个来源的总闸、accept、四格结果、版本与指纹、白名单规模、最近 observe 记录；仅白名单用户或 admin 可用 |
| FR-008 | `resume` 在转换状态前按当前 `whitelist` 与 `policy` 重校验任务的 mandate 与仓库；失败拒绝并说明任务记录的版本与当前版本；admin 不豁免 |
| FR-009 | 策略变更不追溯：排队与运行中的任务不被重新裁决；只有新建任务与 `resume` 使用当前策略 |
| FR-010 | @ 信号：Telegram 用 `getMe` 得到的 bot 用户名匹配文本，私聊视为已 @；程序化来源（webhook / web / GitHub 评论 / cron / proactive）视为已 @，不受 `requireMention` 影响 |

## 4. 验收

1. 默认配置（无 `policy`）下，非白名单用户派活仍回「无权限：该用户不在白名单。」，白名单用户照常建单
2. `telegram.requireMention = true`：白名单用户在群里不带 `@bot` 派活被拒，带 `@bot` 通过
3. `telegram.allowGuests = true`：名单外用户在群里 `@bot` 派活建单，不 @ 被拒
4. `webhook.accept = "observe"`：webhook 投递不建任务，回执说明只记录，`store.recentAdmissions()` 有记录且重复投递只有一条
5. `github.allowed = false`、`cron.accept = "off"`：对应来源被拒，提示带来源名
6. 任务行 `mandate` 与 `policyVersion` 非空；改白名单后指纹变化
7. `/pisa policy` 输出含版本、指纹与四来源规则；非白名单用户调用被拒
8. 降权：任务创建后把 requester 移出白名单，`resume` 被拒且提示「不在白名单」与两版策略版本，任务保持 `paused`
9. 提权可恢复：把来源规则改回放行后同一任务 `resume` 成功
10. `bun test` 与 `bunx tsc --noEmit` 通过

## 5. 非目标

- 每个来源一份独立用户名单；名单仍只有 `whitelist.users` 一份
- 按仓库细分来源规则（仓库白名单仍独立判断）
- 修改策略需要审批或二次确认；配置文件权限即授权边界
- 追溯已入队任务的策略版本；入队后策略变更不影响它们
- GitHub 评论作者进入准入判断；任务归属仍是仓库配置身份（`actor` 只留痕）
- CLI 派活（`pisa task`）：本机 shell 即授权边界，与改配置文件同级，不经 Router 也不受准入规则约束
