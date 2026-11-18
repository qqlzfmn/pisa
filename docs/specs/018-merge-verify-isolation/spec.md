# 018 · 合并前验证的最小权限与超时

- 状态：implemented
- 关联：001（Worker 进程边界）、014（Worker 环境白名单）、015（merge/自举）
- 依赖：014 的 `workerEnv`

## 1. 问题

`/pisa merge` 是自举场景下合入主干前的唯一闸门。它在 `verify/<任务号>` 副本里执行 `bun test`，而这一步：

- 用 `Bun.spawnSync` 的默认行为继承 pisa 进程的完整环境，`GH_TOKEN`、`PISA_TELEGRAM_TOKEN` 都进得去。副本里的代码和测试由 agent 写、来自任务正文，等于用 pisa 身份执行任意代码。
- 没有任何超时。一个 `while(true)`、`sleep` 或长时间等待的用例会让 `handleMerge` 一直挂着，合并消息永远不返回。

复现（改动前，两个独立脚本）：

- 分支里放 `test("slow", async () => { await new Promise((r) => setTimeout(r, 30000)); }, 120000)`：`/pisa merge` 耗时 30.3s，测试通过后照常合入 `main`。
- 分支里放打印 `process.env.GH_TOKEN` 的用例，以 `GH_TOKEN=SECRET-repro-token` 启动 pisa：回执里出现 `Received: "SECRET-repro-token"`。

## 2. 目标

- 验证步骤只拿到 `worker.envAllow` 放行的环境变量，与 Worker 子进程同一份白名单
- 验证步骤有超时，到时杀掉进程（整组），回执明确「验证超时」，主干不变
- 验证输出进回执前过 `redact`

## 3. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 验证命令的环境用 `workerEnv(cfg.worker.envAllow ?? DEFAULT_ENV_ALLOW, process.env)` 构造，不再继承完整 `process.env` |
| FR-002 | `worker.verifyTimeoutSec?: number`，默认 600 秒；没有任何输出也不影响判断，只按墙钟计时 |
| FR-003 | 超时向子进程组发 `SIGKILL`，等待回收后回 `未合并 · <任务号> 验证超时（<N>s）…`；不合入、不写 merge effect |
| FR-004 | 验证失败与超时的输出都先经 `redact` 再拼进回执 |
| FR-005 | 验证步骤不再阻塞事件循环：改为异步等待子进程退出 |

## 4. 验收

1. 分支含 `tests/slow.test.ts`（睡眠 30s），`worker.verifyTimeoutSec = 2`：`handleMerge` 在 2 秒左右返回，回执含「验证超时」，`git rev-parse main` 不变
2. 分支测试打印 `process.env.GH_TOKEN`，父进程带 `GH_TOKEN=SECRET…`：回执不含该明文，且因为没有别的失败，任务照常合并
3. 既有 merge 相关测试保持通过；`bun test` 与 `bunx tsc --noEmit` 通过

## 5. 非目标

- 文件系统或网络隔离：验证副本仍是同一用户、同一台机器（与 001 的非目标一致）
- 验证失败自动重跑：仍是一次定论
- 对 `git rebase` 等 git 子步骤加超时：这些是 pisa 自己拼的参数，不执行分支里的代码
