# 019 · 合并验证的最小权限与超时

- 状态：implemented
- 关联：014（Worker 环境白名单）、013（rewind 账本）、001（Worker 进程边界）
- 依赖：014

## 1. 问题

`/pisa merge` 是自举场景里「合入 main 前唯一的闸门」：它在 `verify/<任务号>` 副本里跑 `bun test`，通过后 `--ff-only` 合入主干。这一步有两个缺陷。

一是环境变量。验证命令走 `sh`（`src/git.ts`），`Bun.spawnSync` 默认继承 pisa 进程的启动环境，于是 `GH_TOKEN`、`PISA_TELEGRAM_TOKEN`、`PISA_WEBHOOK_TOKEN` 都在里面。而副本里的测试是 agent 写的代码，等于用 pisa 的身份、带着全部凭据执行任意代码。

复现（`GH_TOKEN=GHTOKEN_LAUNCH_SECRET` 启动）：

```
GH_TOKEN in verify child: GHTOKEN_LAUNCH_SECRET
```

同一条链路绕过了 014：Worker 子进程的环境已经按白名单裁剪，验证步骤没有。

二是没有超时。`sh` 没有超时参数，`bun test` 里一个 `while (true)` 或 `await sleep(1e9)` 就让 `handleMerge` 永久挂住，任务既不合也不报。

## 2. 目标

- 验证命令只拿到 `worker.envAllow` 白名单里的变量，与 Worker 子进程同一口径
- 验证有上限时间，到点杀掉，回执说明「未合并 · 验证超时」，主干不变
- 上限可配置（`worker.verifyTimeoutSec`），默认 600 秒
- 回执与日志同一套脱敏；agent 代码打印出来的凭据形状文本不出现在回执里

## 3. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `sh(args, cwd?, opts?)` 新增可选 `opts`：`env` 覆盖子进程环境，`timeoutMs` 到点 `SIGKILL` 子进程 |
| FR-002 | `ExecResult` 新增 `timedOut: boolean`，超时被杀时 `code` 为 -1 且 `timedOut` 为 `true` |
| FR-003 | 合并验证用 `workerEnv(cfg.worker.envAllow ?? DEFAULT_ENV_ALLOW, process.env)` 构造环境，不再继承全部变量 |
| FR-004 | `worker.verifyTimeoutSec` 默认 600；验证超时回执「未合并 · 验证超时」，不进入合并，主干不变 |
| FR-005 | Router 的回复统一过 `redact`，与任务日志同一套脱敏规则 |
| FR-006 | 未配置 `worker.verifyTimeoutSec` 时取默认值，不因部分 `worker` 配置丢失 |

## 4. 验收

1. `sh` 带 `env` 时子进程只看得到传入的变量；带 `timeoutMs` 时命令被强杀、`timedOut` 为 `true`
2. 分支里放 `tests/slow.test.ts`（sleep 30s），`worker.verifyTimeoutSec = 2` 时 `handleMerge` 2 秒左右返回「未合并 · 验证超时」，`git log main` 无新提交
3. 分支里放打印 `process.env.GH_TOKEN` 的测试，回执文本不含 token 明文
4. 原有合并成功、rebase 后快进的用例不变
5. `bun test` 与 `bunx tsc --noEmit` 通过

## 5. 非目标

- 文件系统与网络隔离：验证副本仍是本机普通 worktree，没有沙箱
- 验证命令可配置（固定 `bun test`）
- 超时后清理 agent 派生的孙进程：`SIGKILL` 只到直接子进程
- 把 014 的白名单口径扩展到 `gh`、`git` 等 pisa 自身调用
