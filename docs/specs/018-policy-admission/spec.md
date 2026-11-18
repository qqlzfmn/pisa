# 018 · 来源准入策略

- 状态：implemented
- 关联：008（仓库路由）、006（评论派活）、015（Web 控制台）、013（副作用账本）

## 1. 问题

改动前，能不能派活只取决于一处判断：`Router.checkAccess` 里的 `cfg.whitelist.users.includes(msg.userId)`。它有三个后果。

1. 各来源共用一份用户名单，权限粒度到不了来源。GitHub 评论以配置身份投递，评论作者是谁完全不参与判断（006 的非目标）；webhook 与 Web 控制台由 token 认证；定时与探针用配置身份。想「让评论能派活、但陌生人不能在群里派活」没有配置可表达，只能改代码。
2. 「谁在什么时候被放进来」没有记录。任务行只有 `requester`，没有说明它按哪条规则被接下；改严名单后，也不知道旧任务当初凭什么进来。
3. 策略只在前门生效。任务被重启打断成 `paused` 后，`resume` 不做任何复核，直接按工作副本继续；名单收紧后，一个已经失去准入资格的任务照样能被唤醒并继续改代码。

复现（`repro-policy.ts`，已删）：

- 配置 `whitelist.users: ["u1"]`，让 `u2` 在群里发需求：`无权限`，正确。
- 把 `u2` 加进名单，让 `u2` 建任务，再从名单里删掉 `u2`，然后 `resume` 该任务：任务照常进入 `running`，`results` 里没有任何准入复核痕迹。
- GitHub 评论：`gh` 配置身份 `u1` 在名单内，任何能评论该仓库的人写的 `/pisa …` 都会建任务；`whitelist` 无法区分评论作者。

根因：准入不是一个有版本、有记录、能复核的决策，而是一行就地检查。

## 2. 目标

- 每个来源一份准入策略：`allowed` + 四格判定（名单内外 × 是否 @ 本服务）+ 三种动作（`auto` / `observe` / `off`）
- 策略有版本号，任务记录它派活时命中的策略版本与准入凭据（mandate）
- `observe` 的决策要留痕：不建任务，但能查到「谁、什么来源、哪一格、什么时候」被挡下
- `resume` 前按当前策略复核，不通过就拒绝并说明派活时的版本与当前版本
- `/pisa policy` 直接看到当前规则、版本与最近的观察记录数
- 默认行为与改造前一致：IM 只接名单内用户；GitHub 评论沿用「配置身份投递」

## 3. 用户故事

### US-1 运维

作为运维，我把 `telegram.unlisted` 设成 `observe` 就能先看清「哪些陌生人想派活」再决定是否开放；把某来源 `allowed` 设成 `false` 就能整体关掉，不用改代码。

### US-2 维护者

作为维护者，我改窄了名单。旧任务恢复时会被拦下，回复里写明它当初按哪条规则进来、现在为什么不行，而不是悄悄继续跑。

### US-3 审计

作为审计，我能在 `pisa.db` 的 `admissions` 表里看到每一次被拒绝/被观察的决策，以及当时的策略版本。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/policy.ts`：`AcceptMode = "off" \| "observe" \| "auto"`；`AdmissionCell = "listedMention" \| "listedPlain" \| "unlistedMention" \| "unlistedPlain"` |
| FR-002 | 配置新增 `policy.sources.<source>`，字段 `allowed`、`listed`、`unlisted`；`listed`/`unlisted` 可写单个模式同时设两格，或 `{mention, plain}` 分别设 |
| FR-003 | `resolvePolicy(policy, users)` 补默认值并算出 `version`：`sha256` 覆盖「解析后的来源策略 + 排序后的名单」，取前 12 位加 `v` 前缀 |
| FR-004 | 每个来源的默认格：`cli` 与 `github` 四格全 `auto`；其余已知来源与未登记来源都是名单内 `auto`、名单外 `off` |
| FR-005 | `decideAdmission(policy, {channel,userId,actor,mentioned})` 返回 `{version, source, actor, listed, mentioned, cell, mode, reason}`；`reason` 是一句话说明，直接用于回复 |
| FR-006 | 准入判定在 Router 建任务前执行：`auto` 建任务；`observe` 与 `off` 都写 `admissions` 表、都不建任务，回复分别以「已记录，未建任务（观察模式）」与「无权限」开头，按用户 24 小时节流 |
| FR-007 | `checkAccess` 去掉用户白名单判断，只保留仓库层校验（别名存在、在 `whitelist.repos` 内、是 git 仓库） |
| FR-008 | 任务新增 `mandate`（来源、actor、名单内外、是否 @、命中格）与 `policyVersion` 两列；旧库按 `ALTER TABLE` 补列，旧任务为 `null` |
| FR-009 | `resume` 在「原请求者 / 中断状态」校验之后、工作副本校验之前复核：用 mandate（缺失时退回 `task.channel` + `requester`）按当前策略重新判定，非 `auto` 则拒绝，回复里给出派活版本与当前复核结论 |
| FR-010 | 策略变更不追溯：已在队列或运行的任务不受影响，只在 `resume` 时复核 |
| FR-011 | 新增 `/pisa policy`（别名 `策略`，私聊可用 `/policy`）：输出策略版本、每个来源的允许与否与四格模式、最近 `observe` 记录数 |
| FR-012 | `admissions` 表：`(at, source, actor, chat_id, listed, mentioned, cell, mode, policy_version, reason)`；`Retention` 每日按 `retentionDays` 清理 |
| FR-013 | Telegram 入口声明是否 @ 了本服务：启动时 `getMe` 取机器人 username 与 id，按 `entities` 里的 `mention` / `text_mention` 判定；取不到身份时一律视为未 @ |

## 5. 非目标

- 不改 GitHub 评论作者鉴权模型：`github` 来源仍以配置身份投递，不声明 @（评论里的 `@someone` 与「叫机器人」不是一回事），收紧靠 `unlisted` 格
- 不改 agent CLI（`src/cli.ts`）的建任务路径：它直接写 store，不经过 Router，任务 `mandate` 为 `null`；其来源默认四格全放行，因为本地进程即身份
- 不做策略热加载：改配置仍需重启
- 不改 webhook / Web 控制台的 token 鉴权

## 6. 验收

| 场景 | 期望 |
| --- | --- |
| 名单外用户，未 @，该格 `off` | 不建任务，回复含「无权限」 |
| 名单外用户，未 @，该格 `observe` | 不建任务，`admissions` 多一条 `mode=observe`，回复说明观察模式 |
| 名单外用户，@ 了本服务，`unlistedMention=auto` | 建任务，mandate 记 `unlistedMention` |
| GitHub 评论（默认格） | 名单外也建任务，与改造前一致 |
| 任务创建 | `mandate` 与 `policyVersion` 落库，`/pisa policy` 显示同一版本 |
| 建任务后把该用户移出名单，再 `resume` | 拒绝，回复含派活版本与「复核」结论，任务仍 `paused` |
| 建任务后收紧来源 `allowed=false`，再 `resume` | 拒绝，原因指向来源被关闭 |
| 停掉某来源 `allowed` | 该来源的新任务一律不建，其它来源不受影响 |
| 改白名单 | `version` 变化；未重启前判定仍用旧配置，重启后生效 |
