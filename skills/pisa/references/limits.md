# 能力边界

## 能做

| 能力 | 说明 |
| --- | --- |
| 提交编码任务 | 入队到本机 pisa，由守护进程执行 |
| 指定仓库 | `--repo <alias>`，别名来自 `pisa status --json` 的 `repos` |
| 幂等提交 | `--event-id` 重复时返回原任务 |
| 续跑 | `continue` 在父任务分支上继续，继承 PR |
| 阻塞等待 | `wait` / `--wait`，带超时 |
| 观察 | `status`、`list`、`show`、`logs`、心跳与执行器状态 |
| 停止 | queued/paused 立即取消；running 登记取消请求 |
| 重跑 | `retry` 用同一需求新建任务，不带旧分支 |
| 派活开关 | `pause` / `pause --resume` |
| 合并 / 撤销 | `merge --confirm`、`rewind --yes`（行为与聊天通道一致） |
| 机器可读输出 | 所有命令 `--json` |

## 不能做

- **远程调度**：管理接口只监听 `127.0.0.1`。agent 必须在装有 pisa、能访问目标仓库的机器上运行。
- **直接执行 Worker**：CLI 只入队。守护进程不在，任务不会跑。
- **绕过守护进程**：CLI 不打开数据库，读状态也走接口；守护进程死了就查不到状态。
- **恢复 paused 任务**：`resume` 只在 pisa 会话里；CLI 没有该子命令。
- **管理定时任务**：`schedules` 只在会话里。
- **改任务状态**：除 stop / retry / merge / rewind 外，CLI 不推进状态；状态由守护进程推进。
- **跨机器共享状态**：接口与本机文件都不跨主机。
- **自动重试**：没有内建重试；由调用方决定何时 `pisa retry`。

## 执行模型

- 每个新任务使用独立工作副本 `<stateDir>/worktrees/<任务号>`，分支 `pisa/<任务号>`，从仓库当前 HEAD 或配置的 base 创建。
- `continue` 的新任务复用父任务分支（`baseRef=父 branch`），并复用父任务 `prUrl`。
- `retry` 走新任务新分支，上下文里带上一轮状态与错误。
- 新任务之间不共享工作副本；同一仓库可并行，但受 `worker.concurrency` 限制；`pause` 只影响出队，不影响运行中的任务。
- 任务失败或取消时，pisa 删除本任务的工作副本；只有 `pisa/<任务号>` 这种自建分支会被删，续跑共享的父任务分支保留。
- 交付阶段根据 `delivery.push` / `delivery.pr` 决定是否推送、开 PR。未配置时只在本地提交。

## 身份与权限

- CLI 的身份是守护进程按 `web.userId` 配置的固定用户，不是调用者自报的名字；提交记录里的 `requester` 就是它。
- 真正的边界是本机 shell 权限加 token：能读到 token 的人就能操作；token 在 `<stateDir>/mgmt.token`（0600）或 `${web.tokenEnv}`。
- `whitelist.repos` 非空时限制可提交的仓库别名；越权时退出码为 `3`。
- CLI 不校验 `whitelist.users`；该白名单用于聊天通道。

## 数据与隐私

- brief 原文、摘要、错误、分支、PR 链接写入 `<stateDir>/pisa.db`。
- 任务日志写入 `<stateDir>/logs/<任务号>.log`，可能包含代码片段与命令输出。
- 不要把密钥、token、个人隐私写进 brief 或日志；需要凭证时让 Worker 从环境变量读取，并在 brief 里写变量名。
- 不要把 `pisa.db` 或 `mgmt.token` 提交进 git。

## 一致性

- 接口调用最终都落到同一个 `Router`：白名单、状态机、合并前的验证与快进逻辑与 IM 完全一致。
- 状态机唯一入口是 `Store.transition`。
- 心跳阈值 10 秒；守护进程每 800ms 写一次。
- 任务号格式 `t_<yyyyMMdd>_<6位十六进制>`，只用于定位，不要解析出语义。

## 与聊天通道的差异

| 能力 | CLI | 聊天 / GitHub |
| --- | --- | --- |
| 提交 | 有 | 有 |
| 续跑 | 有 | 有（回复消息或 PR 评论） |
| 恢复 paused | 无 | 有 |
| 合并 | 有（需 `--confirm`） | 有（需二次确认） |
| 撤销 | 有（需 `--yes`） | 有 |
| 定时任务 | 无 | 有 |
| 进度推送 | 无（轮询） | 有（实时回执） |
| 完成回帖 | 无 | 有（回到来源消息/PR/Issue） |

CLI 任务完成后不会自动回帖到 IM 或 GitHub；需要回写时由调用方自己决定（例如验收后用 `gh` 评论，且应先得到人类同意）。
