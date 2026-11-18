# 015 · 任务

- [x] `src/config.ts`：`api.{enabled,port}`、默认值与合并
- [x] `src/store.ts`：`setExecutorPaused` / `executorPaused`
- [x] `src/management.ts`：`ManagementError`、`taskView`、`stateView`、`api.json` 读写、接口类型
- [x] `src/log.ts`：日志尾部读取 `readLogTail`
- [x] `src/router.ts`：`createTicket` / `retryTicket` / `stopTicket` / `mergeTicket` / `rewindTicket`，`handle*` 改薄包装，`fill` 尊重暂停
- [x] `src/api.ts`：`startApi`（仅 127.0.0.1、`x-pisa-token`、十个端点、状态码映射）
- [x] `src/api-client.ts`：`ApiClient` 与错误分类
- [x] `src/cli.ts`：命令改名与 API 化、`--json`、退出码 0/1/2/3
- [x] `src/index.ts`：启动管理服务、关停时停止并删除 `api.json`
- [x] `tests/api.test.ts`：鉴权、端点、暂停、重试/停止、错误码
- [x] `tests/cli.test.ts`：端到端覆盖命令与四种退出码
- [x] `docs/specs/015-mgmt-api/`：spec / plan / tasks
- [x] `README.md`、`docs/usage.md`、`docs/architecture.md`、`skills/pisa/`：命令表与退出码
- [x] `pisa.config.example.json`：`api` 段
- [x] 验证：`bun test`、`bunx tsc --noEmit`、临时目录端到端
