# 015 · 评论作者鉴权与入口收窄

- 状态：implemented
- 关联：006 / 007 / 011 建立的评论 → 任务 → 回帖链路；012 的入口命令解析
- 依赖：`github` 配置段、`IncomingMessage.channel`

## 1. 问题

`src/github.ts` 解析了评论作者 `userLogin`，但没有调用方使用；`src/github-watcher.ts` 投递时把 `userId` 固定成配置里的归属身份，于是 Router 的 `checkAccess` 对一个从未核对过的评论也必然通过。公开仓库上任何能评论的人都能派活一个带完整 bash 的 agent，还能用 `/pisa merge` 把分支合进主干并触发看护重启。

根因：把「评论者身份」和「配置归属身份」合并成了同一个字段，鉴权被替换成了新值。

## 2. 目标

- 评论能否派活由评论作者决定，与聊天白名单无关
- 未配置作者白名单时 fail-closed：一条评论任务都不投递，启动日志说明原因
- 任务归属与回执路由保持原样：仍是仓库条目配置的 `chatId` / `userId`
- 原评论作者留痕，可审计
- 非 IM 入口不能改动已有任务：合并、取消、恢复、撤销只接受 IM

## 3. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `github` 新增 `allowedUsers: string[]`（GitHub login，比较时统一小写）。只有作者在列表内的评论才投递 |
| FR-002 | `allowedUsers` 为空或缺失时 fail-closed：`start()` 不装定时器，`poll()` 直接返回，一条评论任务都不建；启动日志打印「评论来源未配置 allowedUsers，评论派活已禁用」 |
| FR-003 | 作者不在列表的评论不投递，每个被拦评论记一条 warn（含仓库、编号、作者）；该轮仍算完整，下界照常推进，避免每轮重复告警 |
| FR-004 | 投递消息的 `userId` 仍是仓库条目的配置值；新增 `IncomingMessage.authorLogin` 携带原评论作者 |
| FR-005 | Router 建任务时把 `authorLogin` 写进任务日志（`.pisa/logs/<任务号>.log`，stage `github`），不进入任务归属字段 |
| FR-006 | `channel` 为 `github` / `webhook` / `proactive` / `cron` 时只允许派活与续跑；`merge` / `cancel` / `resume` / `rewind` 回执「只有 IM 通道可以…」，不执行任何 git 操作 |
| FR-007 | IM 通道（telegram、cli）与只读查询命令行为不变 |

## 4. 验收

1. 给定 `allowedUsers = ["alice"]`，评论作者 `mallory` 发 `/pisa 改 README`，轮询后任务数 0，且有一条 warn
2. 给定评论作者 `alice`，轮询后建 1 个任务，`requester` 为配置的 `userId`，任务日志含 `评论作者：alice`
3. 给定 `allowedUsers = []`，`start()` 后不轮询，`poll()` 建任务数 0，启动日志含禁用提示
4. 给定列表写 `["Alice"]`、评论作者 `alice`，小写比较后通过
5. 给定已成功任务，从 `github` 通道发 `/pisa merge <任务号>`，回执含「只有 IM 通道可以」，主干无新提交

## 5. 非目标

- 按仓库区分配置作者白名单：`allowedUsers` 是 `github` 段全局配置
- 评论作者与 IM 用户的身份映射
- 把只读查询命令也挡在非 IM 入口之外
