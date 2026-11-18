# 017 · 来源准入与策略版本

- 状态：implemented
- 关联：001（任务状态机与恢复）、005（resume 语义）、015（Web 控制台身份）
- 依赖：无

## 1. 问题

原来的准入只有一条规则：请求者必须在 `whitelist.users`、仓库必须在 `whitelist.repos`。它把 IM、webhook、Web 控制台、GitHub、cron、探针当成同一种来源，但它们的威胁模型不同：webhook 只有 token 保护，GitHub 评论作者未参与鉴权，cron 与探针用的是配置身份。想放宽某一来源（比如允许 GitHub 评论续跑）只能整体放开用户白名单。

另一个问题是没有留痕：配置改了什么，正在跑或暂停的任务查不到当时按什么规则进来的，恢复时也无从校验。

## 2. 目标

- 每个来源独立配置：是否开放、accept 模式（off / observe / auto）、`名单内外 × 是否点名` 四格准入表
- 默认值与旧白名单行为一致：名单内放行、名单外拒绝，现有部署不改配置不受影响
- 任务落库时保存准入快照（mandate）与策略版本
- 策略变更不追溯已落库任务；`resume` 前按当前策略重校验，失败则拒绝并说明版本差
- `/pisa policy` 能看当前规则与版本
- 测试覆盖越权、降权、恢复被拒

## 3. 用户故事

### US-1 按来源收紧

作为运维者，我把 `webhook` 的 `accept` 设为 `off`，webhook 再也不能开单，IM 不受影响。

### US-2 先观察再收紧

作为运维者，我把 `github` 设为 `observe`，名单外评论被放行但日志留下拒绝裁决；观察一段时间后再改成 `auto`。

### US-3 查当时规则

作为运维者，我执行 `/pisa policy`，看到当前版本、每个来源的开关与四格结果，能解释「为什么这条消息没进来」。

### US-4 降权后恢复被拒

作为运维者，我把某用户移出白名单，他暂停中的任务执行 `/pisa resume` 被拒，回复说明任务准入版本与当前策略版本。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/policy.ts`：`PolicyConfig.sources[来源]` 可覆盖 `allowed`、`accept`、`admission`；`admission` 分 `member`/`outsider`，各含 `addressed`/`unaddressed` 的 `allow`/`deny`。未写的字段取默认 |
| FR-002 | 默认值保持旧语义：`allowed=true`、`accept=auto`、名单内两格 `allow`、名单外两格 `deny` |
| FR-003 | `admit(host, {source, requester, addressed})` 是唯一裁决入口，顺序固定：`allowed` → `accept` → 准入表。`off` 全拒；`observe` 放行但保留裁决；`auto` 按表执行 |
| FR-004 | 是否点名由入口显式标注或推断：私聊、`admin`、回复某条消息、触发词开头、`/` 开头算点名；关键词派活显式 `addressed=false`；cron/探针沿用其配置身份与未点名 |
| FR-005 | Router 在建任务前调用 `admit`（去重之后、仓库校验之前）；拒绝沿用 24 小时一次的提示节奏，文案带当前策略版本；`observe` 放行时 `console.warn` 记录裁决 |
| FR-006 | 任务落库新增 `mandate` 列（SQLite `TEXT`，JSON），旧库自动 `ALTER TABLE` 迁移；mandate 含来源、请求者、名单内外、是否点名、裁决、模式、策略版本、时间 |
| FR-007 | `policyVersion` 是白名单与所有已配置来源生效策略的稳定指纹（sha256 前 12 位）；配置或名单一改版本就变 |
| FR-008 | 策略变更不追溯：已 `queued` 的任务照常执行；`resume` 前用任务的 mandate（旧任务没有 mandate 时按「点名派活」）对照当前策略重校验，再校验仓库白名单，失败则保持 `paused` 并回复拒绝原因与两个版本 |
| FR-009 | 新增命令 `policy`（`/pisa policy`，私聊可用 `/policy` 或 `准入`），输出当前版本、判断顺序、名单与每个来源的四格 |
| FR-010 | CLI 直接建单（`pisa enqueue`）不经过 Router，`mandate=null`；命令类消息（help/status/policy/cancel/resume/rewind/merge/verbose）不做准入 |

## 5. 验收

1. 配置里每个来源可写 `allowed`、`accept` 与四格准入；不写时行为与旧白名单一致
2. 新建任务 `mandate.version` 等于当时的 `policyVersion`；`policyVersion` 在白名单或来源策略变化后改变
3. 名单外用户被拒时消息含「无权限」与当前策略版本；`observe` 放行且 mandate 保留 `deny`
4. 降权（移出用户名单或仓库名单）后 `resume` 被拒，任务保持 `paused`，回复含「恢复被拒」与「任务准入版本 … 当前策略版本 …」
5. 策略改成 `off` 后，变更前已排队的任务仍能执行成功
6. `/pisa policy` 输出含版本、来源名与四格，且不建任务；私聊 `/policy` 同样可用

## 6. 非目标

- 在线改策略或热加载：仍改配置文件后重启，版本随之变化
- 按来源区分仓库权限：`whitelist.repos` 仍是全局一份
- 追溯重算已落库任务：只保证恢复前校验
- 认证 webhook/Web 控制台身份：仍靠 token，准入只处理其配置身份
- 对查询类命令做准入：只约束「派活」
