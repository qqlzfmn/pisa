# 021 · 来源准入表与策略版本

- 状态：implemented
- 关联：019（通用 Trigger 适配层）、006（GitHub 评论）、017（触发器幂等）

## 1. 问题

派活权限只有一份全局用户白名单（`cfg.whitelist.users`）加仓库白名单，`Router.checkAccess` 对所有入口套用同一套规则。实际入口的信任度不同：

- 私聊/CLI/web 只能由本人操作；webhook 由持有 token 的系统调用；cron 由配置里的 `userId` 代发起。三者都不该和「群成员能派活」共用一个判断。
- 飞书、企业微信的 `userId` 是**投递身份**（配置里写死的 `opts.userId`），真实发送者在 `actor`（openId / 成员账号）。按 `userId` 鉴权等于「谁在群里说话都算配置那个人」，群成员可借机器人派活。
- GitHub 评论文本只要带触发词就投递，评论作者完全没参与鉴权（019 也把这一点写成非目标）。
- 同一个群里，@ 机器人是明确的派活信号，普通发言不是；现在两种都接。

配置改完也查不到影响面：哪些任务是在旧名单下接的、策略什么时候变的、恢复执行该不该重新放行，都没有落点。改白名单只影响新消息，已经卡在 `paused` 的任务可以用 `/pisa resume` 越过新规继续跑。

复现（改动前）：

```text
飞书群配置 { chats: ["oc_x"], users: ["ou_owner"] }，机器人由 ou_owner 身份投递。
群成员 ou_stranger 发「/pisa 把支付模块改成异步」→ 生成任务，requester=ou_owner。
→ 陌生人绕过 white列表派活，且任务看不出是谁要求的。
```

```text
1. whitelist.users = ["u1"]，u1 开单后任务进入 paused（进程重启）；
2. 运维把 u1 从白名单移除；
3. u1 执行 /pisa resume → 任务照旧恢复执行。
→ 降权不追溯，也无从判断旧任务的工作范围。
```

## 2. 需求

FR-001 来源准入表：`policy.sources` 按入口（telegram、cli、web、webhook、cron、github、github-actions、feishu、wecom、file-watch、proactive）配置 `allowed`（准入名单）、`cells`（名单内/外 × 是否 @ 的准入格）、`accept`（`off`/`observe`/`auto`）。未配置的来源沿用 `whitelist.users` 与 `accept=auto`，行为与改动前一致。

FR-002 判定：主体按「是否在准入名单」取行、按「是否 @ 机器人」取列，格值 `deny` 拒绝；`accept=off` 拒绝，`observe` 只记录不建任务。`cells` 缺省为名单内两格 `allow`、名单外两格 `deny`，即未改配置时名单外一律拒绝。群聊类入口（飞书、企业微信、GitHub）在该来源配置了策略时按平台真实发起人（`actor`）判定，`allowed` 缺省取该入口自身的 `users` 白名单。

FR-003 策略版本：策略快照按内容哈希出 12 位版本号；任务落库记录 `mandate`（来源、主体、名单内外、是否 @、命中格、接单时的策略版本）；`observe` 记录进 `admissions` 表，包含策略版本。

FR-004 恢复重校验：`/pisa resume` 在执行前按任务 `mandate` 重新判定；拒绝（越权、格为 `deny`、`accept` 不是 `auto`）时说明原因与版本，任务保持 `paused`。

FR-005 可见性：`/pisa policy` 展示当前所有来源的规则、版本号，以及最近的 `observe` 记录；调用者能看到自己在这个来源下的判定结果。

FR-006 无策略配置时行为不变：既有入口、既有测试、既有任务的 resume 都不受影响。

## 3. 非目标

- 不做按仓库或按任务的细粒度权限：`repos` 白名单保持不变，仍是独立校验。
- 不做策略变更审计流水：只保留任务上的 `mandate` 与 `observe` 记录，不单独落变更日志。
- 不做管理面写接口：策略仍只能改配置文件后重启。
- 不给企业微信补 @ 信息：其回调载荷没有可靠的 @ 标记，按「未 @」判定。

## 4. 验收

1. 每个来源可配 `allowed` + 四格 `cells` + `accept`，未配置来源保持旧行为。
2. 任务记录 `mandate`（含 `policyVersion`）；`observe` 记录含策略版本。
3. 策略收紧后 `/pisa resume` 拒绝并说明原因，任务保持 `paused`；策略未变时照旧恢复。
4. `/pisa policy` 输出规则、版本与 observe 记录。
5. 测试覆盖越权、降权、恢复被拒；`bun test`、`bunx tsc --noEmit` 通过。
