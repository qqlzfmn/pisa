# 014 合并前验证的最小权限执行 · 任务

- [x] T1 复现：验证副本继承 `GH_TOKEN`，且无超时的 `bun test` 在 5 秒后仍未退出
      验证: `/tmp` 探针脚本输出 `存活=true` 与 `GH_TOKEN=<值>`
- [x] T2 `src/env.ts`：`workerEnv` 白名单环境 (FR-001, NFR-001)
      验证: `tests/router.test.ts` 的凭据测试
- [x] T3 `src/git.ts`：`runWithLimit` 异步启动、超时强杀 (FR-002, NFR-002)
      验证: `tests/router.test.ts` 的超时测试
- [x] T4 `src/config.ts`：`worker.verifyTimeoutSec` 默认 600 (FR-002)
      验证: `bunx tsc --noEmit`
- [x] T5 `src/router.ts`：验证改用受限环境与超时，输出脱敏，超时回「未合并 · 验证超时」(FR-003, FR-004)
      验证: 两条新增集成测试
- [x] T6 文档：README 合并一节说明受限环境与超时配置
      验证: 人工检查
- [x] T7 全量校验：`bun test`、`bunx tsc --noEmit`
      验证: 全绿
