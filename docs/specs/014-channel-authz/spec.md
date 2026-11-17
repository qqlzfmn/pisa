# 014 · 评论作者鉴权与通道收窄

- 状态：implemented
- 关联：006（评论轮询与投递）、012（命令解析与误触防护）
- 依赖：006 的评论通道、scheduler / proactive / webhook 的非 IM 入口

## 1. 问题

「评论者身份」与「配置归属身份」被合并成一个字段：`GithubWatcher` 投递评论时把 `userId` 直接填成配置里的 `github.repos[*].userId`，评论作者（`comment.userLogin`，`src/github.ts` 已解析）全仓无人使用。于是 `Router.checkAccess` 看到的永远是白名单内的配置身份，必然通过。

实测（假 runner + 真实临时仓库）：作者 `mallory` 不在任何白名单，评论「/pisa 改 README 并提交」仍生成任务并回执「已接单」；同一路径发 `/pisa merge t_x` 把分支 ff-only 合进主干，主干 sha 从 `b0753b9f` 变为 `55c6ba5e`。

后果：公开仓库上任何能评论的人都能指挥一个带完整 bash 的 agent，还能通过 `merge` 触发自举重启。

此外，webhook / 关键词触发 / 定时任务这些入口同样没有可信的人机身份，却与 IM 共用同一套命令分发：任何能命中的输入都能发 `merge`、`cancel`、`resume`。

## 2. 目标

- 只有配置里点名的 GitHub login 能通过评论派活
- 没配置白名单时 fail-closed：不轮询、不投递，启动日志说明原因
- 评论作者作为审计字段落到任务上，与任务归属（回帖路由用的配置身份）分开
- 非 IM 通道只能派活与续跑；特权命令只认 IM 消息

## 3. 用户故事

### US-1 陌生人评论派不了活

作为仓库维护者，陌生人在 Issue / PR 评论里写 `/pisa 删掉全部测试`，pisa 忽略它，日志留一条忽略记录。

### US-2 升级后不会因为漏配而暴露

作为运维，我升级后没配 `allowedUsers`，pisa 不再轮询任何评论，启动日志告诉我「评论派活已禁用」。

### US-3 评论不能触发自举

作为维护者，评论里的 `/pisa merge <任务号>` 被拒绝，回复只允许 IM 通道执行合并，主干不变。

### US-4 谁提的需求可追溯

作为后来接手的人，我能在任务上看到这单是哪个 GitHub 账号评论触发的，而不只是回帖用的机器人身份。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 配置新增 `github.allowedUsers: string[]`（GitHub login，大小写不敏感，对所有仓库生效） |
| FR-002 | `allowedUsers` 为空或未配置时 fail-closed：不启动轮询、不投递任何评论任务，启动日志打印「评论来源未配置 allowedUsers，评论派活已禁用」 |
| FR-003 | 只有作者在 `allowedUsers` 内的评论能派活；其余评论忽略，并记一条 `console.warn`，含仓库全名、评论 id、作者 login |
| FR-004 | 投递消息的 `userId` 仍是配置值（回帖路由用）；评论作者放 `IncomingMessage.author`，落库到 `Task.author` 供审计；IM 来源的任务 `author` 为 `null` |
| FR-005 | `Router.handle` 解析出命令后按 `channel` 收窄：`channel` 为 `github` / `webhook` / `proactive` / `cron` 时只放行 `task` 与 `continue`，其余命令（含 `confirm`）回执「只有 IM 通道可以…」并返回，不产生副作用 |
| FR-006 | 门禁放在命令分发之前，且早于任何状态写入；被拒的命令不得改动任务状态、不得合并分支、不得登记事件 |

## 5. 验收

1. 给定 `allowedUsers: ["alice"]`，当 `mallory` 评论 `/pisa 改 README 并提交`，任务数为 0，且恰好一条含「非白名单作者」「o/r #7 @mallory」的告警
2. 给定 `allowedUsers: ["alice"]`，当 `Alice`（大小写不同）评论 `/pisa 改 README`，产生 1 个任务：`requester` 为配置的 `userId`，`author` 为 `Alice`
3. 给定 `allowedUsers` 为空或未配置，当 watcher 启动，不发起任何 `gh` 调用、任务数为 0，启动日志为「评论来源未配置 allowedUsers，评论派活已禁用」
4. 给定任务已成功，当 `channel` 为 `github` 的消息发 `merge <任务号>`，回执含「只有 IM 通道可以」，主干 sha 不变、任务分支内容未进主干、任务仍为成功
5. 给定任务在运行，当 `channel` 为 `webhook` / `cron` / `proactive` 的消息发 `cancel` 或 `resume`，回执含「只有 IM 通道可以」，任务状态不变
6. 给定 IM 通道（`telegram` / `cli`）或测试用的普通通道，命令行为与改动前一致

## 6. 非目标

- GitHub 团队、组织、角色维度的鉴权（只按 login 名单）
- 评论作者与 IM 白名单的映射（两边各管各的）
- 评论编辑、删除后的权限回收：已建任务不因作者被移出名单而回滚
- IM 通道内部的权限细分（`whitelist.users` 维持现状）
