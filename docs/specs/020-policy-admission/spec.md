# 020 · 来源准入表与策略版本

- 状态：implemented
- 关联：019（触发适配层）、017（触发器幂等）、006/007（GitHub 评论）、009（定时）

## 1. 问题

谁能派活只有一张表：`whitelist.users`。所有入口共用它，判定发生在仓库校验里：

```ts
// 改动前 src/router.ts checkAccess
if (!cfg.whitelist.users.includes(msg.userId)) return "无权限：该用户不在白名单。";
```

由此三个问题：

1. **入口风险不同，却无法分别收紧**。webhook 与 cron 用配置里的固定身份开单，GitHub 评论的作者不参与鉴权，IM 群消息任何群成员都能发。想让「群里必须 @ 机器人」或「GitHub 评论一律只记录」，只能改代码。
2. **配置改了什么，在跑的任务查不到**。任务表只存 `requester`，没有记录建单时命中的规则，也没有策略版本；事后无法回答「这个任务当时凭什么被放行」。
3. **恢复不复核**。`handleResume` 只校验原请求者与中断状态，策略收紧后仍会把暂停的任务拉起来。

证据（改动前，`src/router.ts`）：`checkAccess` 只读 `whitelist.users`，与 `msg.channel` 无关；`handleResume` 在 `status === "paused"` 校验之后直接 `transition("running")`；`grep -rn "policy" src/` 无命中。

## 2. 需求

FR-001 每个来源（`IncomingMessage.channel`）可有独立策略：`allowed`（认可哪些发起人，缺省沿用 `whitelist.users`）、`accept`（来源级闸门 `off`/`observe`/`auto`）、`cells`（单元级覆盖）。

FR-002 准入单元是「名单内外 × 是否点名机器人」四格：`member.mentioned`、`member.unmentioned`、`stranger.mentioned`、`stranger.unmentioned`。缺省 `member.* = auto`、`stranger.* = off`，即行为与改动前一致。

FR-003 判定顺序：来源 → 名单内外 → 是否点名 → 单元；`accept` 为 `auto` 时取 `cells[单元]`，否则 `accept` 覆盖所有单元。`auto` 建任务，`observe` 只记录事件并回一条说明，`off` 拒绝（沿用 24 小时一次的拒绝提示节流）。

FR-004 点名语义：入口显式给出 `mentioned` 优先；缺省按「不是群聊即点名」推断。Telegram 从 `entities` 的 `mention`/`text_mention` 取，飞书从 `@_user_` 占位或 `mentions` 取。

FR-005 任务落库时记录 `mandate`：来源、发起人、是否点名、名单内外、命中单元、方式、策略版本、判定时间。

FR-006 策略版本是准入相关配置的指纹（`whitelist.users` + 各来源生效规则），与准入无关的配置变化不换版本。启动日志打印当前版本。

FR-007 策略改动不追溯：已有任务保留建单时的 `mandate`，不回写。

FR-008 恢复前重校验：`resume` 按当前策略重新判定任务的来源与发起人，不是 `auto` 就拒绝，回执说明原因与建单时/当前两个版本，任务保持 `paused`。没有 `mandate` 的旧任务按 `channel` + `requester` 重判。

FR-009 `/pisa policy`（别名 `/策略`，私聊免触发词）输出当前版本、默认规则与每个已配置来源的生效规则。

FR-010 仓库白名单与准入分离：准入决定谁能派活，`whitelist.repos` 只决定落在哪个仓库。

## 3. 非目标

- 不做按仓库、按群、按线程的更细粒度授权（只到来源 + 名单 + 是否点名）。
- 不做策略变更审计表：版本是配置指纹，不记录谁在何时改了什么。
- 不改 GitHub 评论与 webhook 的既有验签：策略只决定放行方式，不替代签名校验。
- 不追溯改写历史任务的 `mandate`，也不回填旧任务的策略版本。

## 4. 验收

1. 配置 `policy.sources.<来源>` 可设 `allowed`、`accept`、`cells`，缺省值与改动前行为一致。
2. 任务表有 `mandate` 列，读出的任务带 `mandate.policyVersion`。
3. 策略收紧后，已建任务保留原 `mandate`；`resume` 被拒并说明原因与两个版本。
4. `/pisa policy` 输出当前规则与版本。
5. `tests/policy.test.ts` 覆盖越权、降权、`observe`、恢复被拒、旧任务恢复放行、版本稳定性；`bun test`、`bunx tsc --noEmit` 通过。
