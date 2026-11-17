# 014 · 任务清单

- [x] T1 `src/capabilities.ts`：类型、`resolveCapabilities`、`capabilityEnv`、`checkBashCommand`、`checkToolCall`
- [x] T2 `src/config.ts`：`capabilities`、`RepoConfig.capabilities`、`ScheduleJob.capabilities`
- [x] T3 `src/types.ts`：`IncomingMessage.capabilities`、`Task.capabilities`
- [x] T4 `src/store.ts`：`tasks.capabilities` 列与迁移、`task_audit` 表、`setCapabilities` / `recordAudit` / `auditOf`
- [x] T5 `src/router.ts`：接单解析并落库（未知档案拒绝建任务）、执行下发、blocked 事件写审计、退出前补读进度尾部
- [x] T6 `src/worker.ts`：`capabilityEnv` 白名单、无快照拒绝启动
- [x] T7 `src/adapters/{types,omp}.ts`：`AdapterInput.capabilities`、提示词能力段、`--add-dir`
- [x] T8 `extensions/pisa-worker.ts`：调用 `checkToolCall`，拒绝时 block + 写 `blocked` 事件
- [x] T9 `tests/capabilities.test.ts`：解析、默认拒绝、显式放行、env、审计、扩展拦截
- [x] T10 `tests/router.test.ts`：快照落库与审计、仓库能力配置、未知档案
- [x] T11 `tests/adapter.test.ts`：`--add-dir`
- [x] T12 文档：`docs/specs/014-runtime-capabilities/`、README、`pisa.config.example.json`
