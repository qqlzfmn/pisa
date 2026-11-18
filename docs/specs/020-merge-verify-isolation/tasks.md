# 020 · 任务

- [x] `src/config.ts`：`worker.verifyTimeoutSec?: number`、`DEFAULT_VERIFY_TIMEOUT_SEC`、默认 600
- [x] `src/git.ts`：`sh()` 接受 `env` / `timeoutMs`，超时 SIGKILL，返回 `timedOut`
- [x] `src/router.ts`：验证命令改用 `workerEnv` 裁剪后的环境，加超时，超时回「未合并 · 验证超时」，失败输出经 `redact`
- [x] `tests/router.test.ts`：慢测试超时后 main 不变；打印 token 的测试，回执无明文
- [x] `tests/worker.test.ts`：部分 `worker` 配置下 `verifyTimeoutSec` 取默认 600
- [x] `pisa.config.example.json`、`docs/operations.md`、`docs/usage.md`、`CHANGELOG.md` 同步
- [x] 验证：`bun test`、`bunx tsc --noEmit`
