# 018 · 任务

## 1. 契约与客户端

- [x] `src/api.ts`：`EXIT`、`apiToken`、`apiBase`、`ApiClient`、`ApiUnavailable`/`ApiError`
- [x] `src/web.ts`：鉴权改请求头、路由改为 `/state`、`/tickets*`、`/executor/*`，错误码映射
- [x] `src/status.ts`：`ticketJson`、`STATUS_LABEL`、`formatStatusBoard(snapshot)`

## 2. 服务端能力

- [x] `src/store.ts`：`taskByEvent`
- [x] `src/types.ts`：`failed → queued`
- [x] `src/router.ts`：`retry` 命令、`pauseExecutor`/`resumeExecutor`/`executorState`、`fill` 门闩
- [x] `src/config.ts`：`COMMANDS` 增 `retry`，`usage.ts` 文案
- [x] `src/index.ts`：无条件启动管理服务

## 3. CLI

- [x] `src/cli.ts` 改为 API 客户端：`run|continue|wait|status|list|show|logs|stop|retry|merge|rewind|repos`
- [x] 退出码映射 0/1/2/3
- [x] `--json` 全命令覆盖

## 4. 前端与文档

- [x] `src/web-ui.ts`：路径与请求头
- [x] `docs/architecture.md`：跃迁表、文件表
- [x] `docs/operations.md`、`docs/usage.md`、`README.md`、`skills/pisa/*`：命令与退出码
- [x] `docs/specs/014-agent-cli/spec.md`、`017-task-stages/spec.md`：标注被 018 取代的决策
- [x] `CHANGELOG.md`

## 5. 验证

- [x] `tests/web.test.ts`：端点、鉴权、retry/stop/pause、错误码
- [x] `tests/cli.test.ts`：真实服务 + `PISA_API_URL`，覆盖退出码 0/1/2/3 与越权
- [x] `bun test`、`bunx tsc --noEmit`
