# 能力边界

## 能做

| 能力 | 说明 |
| --- | --- |
| 提交编码任务 | 入队到本机 pisa，由守护进程执行 |
| 指定仓库 | `--repo <alias>`，别名来自配置 |
| 幂等提交 | `--event-id` 重复时返回原任务 |
| 续跑 | `continue` 在父任务分支上继续，继承 PR |
| 阻塞等待 | `wait` / `--wait`，带超时 |
| 观察 | `status`、`list`、`show`、`logs`、心跳 |
| 取消 | queued/paused 立即取消；running 登记取消请求 |
| 机器可读输出 | 所有查询命令 `--json` |

## 不能做

- **远程调度**：CLI 只读写本机配置与 SQLite。agent 必须在装有 pisa、能访问目标仓库的机器上运行。
- **直接执行 Worker**：CLI 只入队。守护进程不在，任务不会跑。
- **恢复 paused 任务**：`resume` 只在 pisa 会话里；CLI 没有该子命令。
- **合并 / 撤销**：`merge`、`rewind` 只在 pisa 会话里；需要人类操作。
- **管理定时任务**：`schedules` 只在会话里。
- **改任务状态**：除 cancel 外，CLI 不写运行中/完成状态；状态由守护进程推进。
- **跨机器共享状态**：`pisa.db` 是本地文件，不要放网络盘并发写。
- **自动重试**：没有内建重试；由调用方决定。

## 执行模型

- 每个新任务使用独立工作副本 `<stateDir>/worktrees/<任务号>`，分支 `pisa/<任务号>`，从仓库当前 HEAD 或配置的 base 创建。
- `continue` 的新任务复用父任务分支（`baseRef=父 branch`），并复用父任务 `prUrl`。
- 新任务之间不共享工作副本；同一仓库可并行，但受 `worker.concurrency` 限制。
- 任务失败或取消时，pisa 删除本任务的工作副本；只有 `pisa/<任务号>` 这种自建分支会被删，续跑共享的父任务分支保留。
- 交付阶段根据 `delivery.push` / `delivery.pr` 决定是否推送、开 PR。未配置时只在本地提交。

## 身份与权限

- `requester` 默认取 `PISA_CLI_USER`、`USER`，或 `--requester`；它是自报名字，不是认证。
- 真正的边界是本机 shell 权限：能运行 CLI 的人就能提交任务。
- `whitelist.repos` 非空时限制可提交的仓库别名；空列表表示不限制仓库，但仍要求仓库已配置且是 git 仓库。
- CLI 不校验 `whitelist.users`，也不经过 `policy` 准入表；两者管的是聊天通道（IM、GitHub 评论、webhook、cron、主动发现）。
- 聊天通道按 `policy` 准入：每个来源有开关、主体名单、四格矩阵（名单内外 × 是否 @）与档位（`auto` / `observe` / `off`）。每条任务记下当时的 `mandate` 与策略版本，`resume` 前按当前策略复核。

## 数据与隐私

- brief 原文、摘要、错误、分支、PR 链接写入 `<stateDir>/pisa.db`。
- 任务日志写入 `<stateDir>/logs/<任务号>.log`，可能包含代码片段与命令输出。
- 不要把密钥、token、个人隐私写进 brief 或日志；需要凭证时让 Worker 从环境变量读取，并在 brief 里写变量名。
- 不要把 `pisa.db` 提交进 git。

## 一致性

- SQLite WAL 支持 CLI 与守护进程并发；`insertTaskOnce` 保证事件与任务同事务。
- 状态机唯一入口是 `Store.transition`；CLI 的 cancel 也走它。
- 心跳阈值 10 秒；守护进程每 800ms 写一次。
- 任务号格式 `t_<yyyyMMdd>_<6位十六进制>`，只用于定位，不要解析出语义。

## 与聊天通道的差异

| 能力 | CLI | 聊天 / GitHub |
| --- | --- | --- |
| 提交 | 有 | 有 |
| 续跑 | 有 | 有（回复消息或 PR 评论） |
| 恢复 paused | 无 | 有 |
| 合并 | 无 | 有 |
| 撤销 | 无 | 有 |
| 定时任务 | 无 | 有 |
| 进度推送 | 无（轮询） | 有（实时回执） |
| 完成回帖 | 无 | 有（回到来源消息/PR/Issue） |

CLI 任务完成后不会自动回帖到 IM 或 GitHub；需要回写时由调用方自己决定（例如验收后用 `gh` 评论，且应先得到人类同意）。
