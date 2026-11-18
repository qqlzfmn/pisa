# 016 · 任务

- [x] `docs/specs/016-mgmt-api/spec.md`：seed 术语到 pisa 的映射、接口与退出码契约
- [x] `src/config.ts`：`Config.configPath`，健康检查用于重新加载磁盘配置
- [x] `src/store.ts`：`getMeta` / `setMeta`，`beat` 复用
- [x] `src/health.ts`：`configHash`、`healthOf`（待配置 > 部件错误 > 需重启）
- [x] `src/router.ts`：`retryTask`（幂等派生）、`cancelTask` / `mergeTask` / `rewindTask` 返回结构化结果、`setPaused` / `executorState`，`fill` 尊重暂停
- [x] `src/web.ts`：`GET /api/state`、`POST /api/executor/pause`、`/retry`、`/rewind`；`/api/*` 只认请求头，去掉 cookie
- [x] `src/web-ui.ts`：改用 `Authorization` 头，token 存进 `sessionStorage`（刷新不丢），`/ui` 作为不含数据的壳公开返回
- [x] `src/mgmt.ts`：本机管理接口客户端（地址、凭证、超时、错误分类）
- [x] `src/cli.ts`：`run`（同 `task`）、`logs --json`、`merge`、`rewind`、`retry`、`executor pause|resume`；`status` 走接口并返回健康码；`cancel` 优先走接口
- [x] `src/index.ts`：启动写 `meta["config.hash"]`，日志打印管理接口地址
- [x] `docs/specs/015-web-console/spec.md`、`README.md`、`docs/architecture.md`、`CHANGELOG.md`、`skills/pisa/SKILL.md`：鉴权与命令变更
- [x] `tests/mgmt.test.ts`：state/暂停/重试/停止/撤销、请求头越权、退出码
- [x] `tests/web.test.ts`：cookie 移除、`/ui` 公开、`/api/*` 只认请求头的鉴权用例
- [x] `tests/cli.test.ts`：健康配置、`--json` 管理命令（经真实 HTTP 服务）
- [x] 验证：`bun test`、`bunx tsc --noEmit`
