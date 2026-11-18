# 019 · 任务

- [x] `src/git.ts`：`sh` 支持 `env` / `timeoutMs`，`ExecResult.timedOut`
- [x] `src/config.ts`：`worker.verifyTimeoutSec?: number`，默认 600
- [x] `src/router.ts`：验证命令用 `workerEnv` 裁剪环境 + `verifyTimeoutSec` 超时，超时回「未合并 · 验证超时」；回复统一过 `redact`
- [x] `tests/git.test.ts`：`sh` 的 env 覆盖、超时强杀与 `timedOut`
- [x] `tests/router.test.ts`：慢测试超时不合并、主干不变；打印 token 的测试回执无明文；合并成功回归
- [x] `pisa.config.example.json`：示例写出 `verifyTimeoutSec`
- [x] 文档：`docs/operations.md` 自举步骤、`docs/architecture.md` 已知限制、`README.md` 自举与已知限制、`CHANGELOG.md`
- [x] 验证：`bun test`、`bunx tsc --noEmit`
