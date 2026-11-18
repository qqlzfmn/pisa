# 020 · 实施计划

## D1 管理路由单独成文件，挂在现有 HTTP 服务上

`src/mgmt.ts` 导出 `createManagementApi(deps)` 与 `isManagementPath(path)`；`web.ts` 在 `/health` 之后、浏览器 token 解析之前分派。理由：管理接口的鉴权与错误体跟控制台不同，混在一个 route 函数里会变成两套 if 嵌套。

代价是 `web.ts` 要把串行执行器（`run`）注入进去。这是有意的：写操作必须继续走同一条串行队列，否则派活与合并会互相踩回执总线。

## D2 写操作仍翻译成 `IncomingMessage`

`controlMessage(cfg, identity, kind, body, repo?, eventId?)` 生成 admin 消息，`channel: "api"`。派活、续跑、停止、合并、撤销都由 Router 的既有命令处理，管理接口只做参数校验与结果判定：

- `stop` 成功判据：任务是 `cancelled` 或已登记取消请求
- `merge` 成功判据：`store.effectsOf(id)` 出现 `merge` 副作用
- `rewind` 执行成功判据：任务转为 `rewound`

这三条判据与控制台一致，不解析回执文本。

## D3 `retryTask` 放在 Router

重试要建任务、占事件号、校验仓库，这些都只有 Router 有。放在 API 里等于复制一遍任务构造。`retryTask` 不复用旧分支：失败任务的分支在 `cleanupBranch` 后已经不存在，复用会让工作副本创建失败。上下文交给 `retryContext(parent)`，带上上一轮状态与错误。

## D4 暂停派活是内存状态

`Router.paused` 只影响 `fill()`；不写库、不跨重启。重启后是否暂停由运维重新决定，避免「上次暂停后忘了恢复」被永久继承。`POST /executor/pause` 是明确动作，`GET /state.executor` 是唯一可观察点。

## D5 token 落盘

`resolveToken` 在未配置环境变量时生成一次性 token；CLI 拿不到。改为 `startWebServer` 把解析出的 token 写入 `<stateDir>/mgmt.token`（0600）。`.pisa/` 已在 `.gitignore`，权限只给当前用户。CLI 优先环境变量，其次文件；两者都没有时退出 3，提示如何配置。

## D6 CLI 只做 HTTP

`src/cli.ts` 删除 `Store`、`loadConfig` 之外的本地状态访问；`openClient` 负责配置 → base URL + token。错误分三类：`ConfigError`（退出 3）、`ApiError`（按 `code` / `status` 退出 2 或 3）、`UsageError`（退出 2）。`--wait` 改成轮询 `GET /tickets/:id`。

## D7 看板投影统一

`status.ts` 用 `BoardView`（`TaskJson` 列表 + 计数）替代 `statusSnapshot`；文本看板 `formatBoard(view)` 同时服务 `/pisa status`、`pisa status`。这样 CLI 不在本地读库也能打印同一份看板，且字段集合只有一处定义。

## D8 测试

- `tests/mgmt.test.ts`：直接喂 `createWebApp` 返回的函数，覆盖鉴权矩阵、`/state`、详情、stop、retry、pause 与 405/404
- `tests/cli.test.ts`：真实 `Bun.serve` 跑 `createWebApp`，CLI 走 HTTP；另用桩服务验证 `merge` 退出 1，用关闭的端口验证退出 2，用缺配置/错 token 验证退出 3
