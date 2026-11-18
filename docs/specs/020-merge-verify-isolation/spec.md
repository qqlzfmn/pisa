# 020 · 合并闸门的验证隔离

- 状态：implemented
- 关联：014（Worker 环境白名单）、012（命令守卫）
- 依赖：014 的 `workerEnv`

## 1. 问题

`/pisa merge` 在验证副本跑 `bun test` 时，`sh()` 继承 pisa 进程的完整环境（含 `GH_TOKEN`、`PISA_TELEGRAM_TOKEN`），且没有超时。验证副本里是 agent 写的代码与测试，等于用 pisa 身份执行任意代码；一条 `sleep 30` 或 `while(true)` 就会把 `handleMerge` 挂住。自举场景下这条路径是合入 `main` 前唯一的闸门。

复现：任务分支里放一个打印 `process.env.GH_TOKEN` 的测试并让它失败，回执直接带出变量值（若 pisa 启动环境里有该变量）；分支里放 30 秒的 `sleep`，`handleMerge` 同步阻塞到测试结束。

## 2. 目标

- 验证子进程只拿到 `worker.envAllow` 白名单里的变量
- 验证有硬超时；超时杀掉进程并拒绝合并，`main` 不变
- 测试输出进回执前脱敏

## 3. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `worker.verifyTimeoutSec?: number`，默认 `DEFAULT_VERIFY_TIMEOUT_SEC`（600 秒） |
| FR-002 | `sh(args, cwd?, opts?)` 支持 `env` 与 `timeoutMs`；超时用 SIGKILL 杀掉，返回值带 `timedOut` |
| FR-003 | `handleMerge` 跑 `bun test` 时传 `workerEnv(cfg.worker.envAllow ?? DEFAULT_ENV_ALLOW, process.env)` 与 `verifyTimeoutSec` 对应的超时 |
| FR-004 | 超时回执为「未合并 · <任务号>」+「验证超时（Ns）」，不做 rebase 之后的任何合并动作 |
| FR-005 | 测试失败回执里的输出经 `redact` 脱敏 |

## 4. 验收

1. 分支含 30 秒慢测试、`verifyTimeoutSec` 设为 2 时，`handleMerge` 3 秒内返回「未合并 · 验证超时」，`git log main` 无新提交
2. 分支测试打印 `process.env.GH_TOKEN` 并用 token 明文抛出错误时，回执不含该明文
3. `bun test` 与 `bunx tsc --noEmit` 通过

## 5. 非目标

- 网络与文件系统级沙箱：验证进程仍以 pisa 用户身份运行
- 子进程内部的进程树治理：只杀直接子进程
- 把超时配置搬到每个仓库条目
