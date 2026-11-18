# 015 · 来源准入策略与策略版本

- 状态：implemented
- 关联：001（`Router.handle` 入口）、006/007（GitHub 评论与 Issue）、009（定时）、014（主动发现、命令清单）
- 依赖：无

## 1. 问题

派活入口有五个来源：IM（Telegram 与本地 CLI）、GitHub 评论、webhook、cron、主动发现。它们的权限实质不同，却共用一个 `checkAccess`：

- `src/router.ts` 的 `checkAccess` 只有一条主体判断：`whitelist.users.includes(msg.userId)`。而 GitHub 评论的 `userId` 是配置里的归属身份（`github.repos[].userId`），评论作者 `userLogin` 在 `src/github-watcher.ts` 里被丢弃。结果是任何人只要在受监听仓库的 PR 下写 `/pisa …`，都会以归属身份开单。README 与 `docs/usage.md` 把这条写成「评论作者不参与鉴权」，等于承认漏洞。
- 主动发现的关键词路径用 `k.userId ?? whitelist.users[0]` 冒充身份（`src/proactive.ts`），实际触发人是集团成员，同样绕过了主体判断。
- 准入没有「是否 @」的维度：群里带触发词（明确点名）与关键词误触（没人点名）在权限上被同等对待。
- 准入规则只有一份全局白名单，没有按来源分别配置的入口，也无法灰度：改白名单立即影响所有来源，没有「先观察、只记录」的中间档。
- 任务落库时不记录「谁在什么规则下授权了这次派活」。配置改过之后，已经排队或暂停的任务查不到当初的授权依据；`resume` 直接复用中断前状态继续跑，不复核策略。

## 2. 目标

- 准入表按来源分列：来源开关、主体名单、四格准入矩阵（名单内外 × 是否 @）、执行档位（`off` / `observe` / `auto`）
- 准入表的内容哈希作为策略版本；配置一动版本就变
- 每个新任务记录 `mandate`：来源、主体、名单内外、是否 @、命中的格、矩阵判定、当时档位、实际处置、策略版本
- 策略变更不追溯已接任务；`resume` 前用当前策略重校验任务 mandate，不通过则拒绝并说明原因，任务保持中断状态
- `/pisa policy` 展示当前策略、每来源生效值与版本
- 默认值沿用改造前的判定强度：`im` 只认 `whitelist.users`，其余四个来源不看主体、一律接单；本规格不新增默认拦截

## 3. 用户故事

### US-1 按来源分权

作为运维者，我在配置里把 `github` 来源的「名单外 + @」一格设为拒绝，之后非名单作者在 PR 下写 `/pisa …` 时收到拒绝回执，不产生任务；IM 不受影响。

### US-2 灰度新规则

作为运维者，我把某个来源的档位设为 `observe`：新规则只记录、不拦截，任务照建，`mandate` 里能看到本应被拒的判定；确认规则正确后再改成 `auto` 正式生效。

### US-3 任务可审计

作为运维者，我查看任务时能看到这次派活来自哪个来源、哪个主体、命中哪一格、依据哪个策略版本。

### US-4 恢复前重校验

作为运维者，我把某来源收紧成拒绝之后，该来源此前暂停的任务在 `resume` 时被拒绝，回执写明原因与新旧版本，任务保持暂停。

### US-5 查看策略

作为使用者，我发 `/pisa policy`，看到当前版本与每个来源的开关、档位、名单与四格结果。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/policy.ts`：来源枚举 `im` / `github` / `webhook` / `cron` / `proactive`，格枚举 `inMention` / `inPlain` / `outMention` / `outPlain`（名单内/外 × 是否 @），档位 `off` / `observe` / `auto` |
| FR-002 | `Config.policy.sources.<来源>` 可选字段：`allowed`（布尔，缺省 `true`）、`principals`（主体名单，缺省沿用 `whitelist.users`）、`cells`（四格判定，缺省取该来源默认值）、`accept`（缺省 `auto`） |
| FR-003 | 来源默认值沿用改造前的判定强度：`im` 名单内两格接受、名单外两格拒绝（原白名单语义）；`github` / `webhook` / `cron` / `proactive` 四格全接受（改造前本就没有按主体核查，凭 token、配置身份或冷却约束） |
| FR-004 | `effectivePolicy(policy, whitelistUsers)` 归一化配置并计算版本：`sha256` 规范化 JSON 的前 8 位十六进制；同一配置恒等，改动任一字段即变 |
| FR-005 | `decideAdmission(policy, {source, principal, mentioned})` 返回 `Mandate`：`allowed=false` 一律拒绝；档位 `off` 一律拒绝；档位 `observe` 一律 `observe`（接单并记账）；档位 `auto` 按四格判定 |
| FR-006 | 来源归类：`origin` 显式指定优先；否则 `telegram` / `cli` 归 `im`，`github` / `webhook` / `cron` 各归自身，未知通道归 `im`。主体取 `principal`，缺省 `userId`；`mentioned` 取显式值，缺省为「私聊或正文含触发词」 |
| FR-007 | `GithubWatcher` 投递时带评论作者 `userLogin` 作主体、`mentioned=true`；主动发现关键词投递带来源 `proactive`、真实发信人作主体、`mentioned=false` |
| FR-008 | `Router.handle` 用 `decideAdmission` 替换主体白名单判断：`deny` 回执以 `无权限：` 开头并附原因与版本（沿用 24h 节流），不建任务；`observe` 建任务并在回执注明观察档位 |
| FR-009 | 任务新增 `mandate` 字段（JSON 落库，可空以兼容 CLI 直投与历史行）；`Task` 必填 `mandate: Mandate | null`；`pisa show` 的「准入」行用 `formatMandate` 一行说清来源、主体、命中格、处置与版本 |
| FR-010 | `Router.handleResume` 在状态检查后按当前策略重校验 `task.mandate`，`deny` 时回执写明原因、任务授权版本与当前版本，任务保持 `paused`；无 mandate 的任务（CLI 直投、历史数据）不重校验 |
| FR-011 | 新增命令 `policy`（别名 `策略`，进菜单，查询组）：输出版本、每个来源的开关、档位、名单与四格结果，并说明名单缺省来源 |
| FR-012 | `store` 为 `tasks` 增列 `mandate TEXT`，构造时对旧库 `ALTER TABLE` 补列；`insertTask` / `toTask` 双向映射 |

## 5. 验收

1. `im` 来源四格设 `outMention: deny` 后，`userId=u9`、带触发词的消息不建任务，回执含 `无权限`、原因与策略版本；同配置下 `userId=u1` 照常建任务
2. `im.cells.outMention=deny` + `accept=observe` 时同一消息照常建任务，回执含「观察」，任务 `mandate.outcome = "observe"`、`mandate.verdict = "deny"`
3. 建任务后把来源收紧为 `allowed:false`：新消息被拒，已建任务的 `mandate` 不变（不追溯）
4. 上述被收紧来源的暂停任务 `resume` 被拒，回执含原因与新版本，任务仍为 `paused`；策略放宽后同一任务可恢复
5. `/pisa policy` 输出的版本与 `effectivePolicy` 计算一致，包含五个来源与四格结果
6. 同一策略重复计算版本相同；改动任一格或名单后版本变化
7. `github` 投递带 `principal`，配置 `outMention: deny` 时非名单作者被拒；默认配置下非名单作者仍可派活（与改造前一致）
8. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- CLI 直投（`src/cli.ts`）不经过准入表：它是本地通道，受文件系统权限保护，任务 `mandate` 为 `null`
- 不做逐任务重算历史授权，也不改写已有任务；策略变更只影响新派活与恢复
- 不做审批流：`observe` 不产生待确认任务，只记录判定
- 不把仓库白名单并进准入表；`whitelist.repos` 与 git 仓库检查保持原样
- 不新增配置热加载：策略在进程启动时读取，改配置需重启（与其它配置项一致）
- 不改写 webhook / cron / 探针的配置身份校验方式：改造前这些身份也要在 `whitelist.users` 里，现在它们按来源默认全接受。身份由配置写死，闸门在 token 或 operator 自己的 cron；要恢复旧语义就把该来源的名单外两格设 `deny`（或配 `principals`）
