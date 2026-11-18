# 018 · 任务

- [x] `src/config.ts`：`worker.verifyTimeoutSec?: number`，`DEFAULT_CONFIG` 取 600
- [x] `src/git.ts`：`shTimed(args, { cwd, env, timeoutMs })`，异步等待、超时 `SIGKILL` 进程组并标记 `timedOut`
- [x] `src/router.ts`：验证步骤改用 `workerEnv` 白名单 env + `shTimed(cfg.worker.verifyTimeoutSec ?? 600)`，超时回执「验证超时」，输出过 `redact`
- [x] `tests/router.test.ts`：慢测试 + `verifyTimeoutSec = 2` 返回未合并且 `main` 不变；打印 `GH_TOKEN` 的用例回执不含明文
- [x] `pisa.config.example.json`、`docs/architecture.md`、`docs/operations.md`、`CHANGELOG.md`：补 `verifyTimeoutSec` 与验证步骤说明
- [x] 验证：`bun test`、`bunx tsc --noEmit`
