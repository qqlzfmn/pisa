# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。本文件从 `0.1.0` 起记录；版本号以 `package.json` 为准。

## [Unreleased]

## [0.1.0] - 2026-11-18

### 新增

- Router + Worker：一个入口收消息，按仓库分派到隔离 worktree 执行，结果回到原会话
- 多 Worker 并行，`worker.concurrency` 控制上限（默认 2），任务级隔离
- 通道：Telegram（私聊直说、群聊需触发词）、本地 CLI、webhook `POST /event`（`127.0.0.1` + `x-pisa-token`）
- GitHub 评论派活：多仓库轮询，按仓库隔离增量下界与去重；PR 上已有任务则接续分支，Issue 来源的任务开新分支并回帖，PR 正文带 `Closes #<n>`
- 主动发现：群聊关键词触发 + 定时探针（命令退出码非 0 即开单）
- 定时任务：cron 到点开单，同一分钟只投一次，`/pisa schedules` 查看
- 崩溃恢复：`running` 任务在进程重启后转 `paused`，`/pisa resume` 拉回；孤儿任务收口、任务级超时
- `/pisa rewind`：只读预览并撤销任务副作用（PR、本地与远程分支、工作副本），已合并任务用 revert 提交回退
- `/pisa merge`：临时副本跑 `bun test`，通过后 `--ff-only` 合入 main，看护进程拉起新代码
- Agent CLI（`pisa task/wait/status/show/logs/cancel`）与 `skills/pisa/` 可复用 skill
- Worker 边界 guard：拦截 push、rebase、`reset --hard`、`clean -f`、分支切换与删除、`worktree remove`、`commit --amend`、sudo、`rm -rf /`、workdir 外的文件读写；规则见 `docs/specs/014-worker-guard/`
- 数据保留：`retentionDays` 定期清理事件与进度文件，日志按 10 MiB 轮转，每周 VACUUM
- 仓库工程化：GitHub Actions 跑 `bun test` 与 `bunx tsc --noEmit`；Issue 表单（bug / feature）；PR 模板含验证与回滚说明；新增 [CONTRIBUTING.md](./CONTRIBUTING.md)、[SECURITY.md](./SECURITY.md)、本文件
