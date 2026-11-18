# 018 · 方案

## 1. 结构

```
脚本 / agent / 人
   └─ pisa CLI ──HTTP(127.0.0.1, x-pisa-token)──> 管理服务
                                                    └─ Router.handle(消息) ──> 状态机 ──> SQLite
```

CLI 只做参数解析、HTTP 调用与输出格式化；所有写操作仍以「构造一条 IncomingMessage 交给 Router」的方式进入状态机，不新增第二条写入路径。

## 2. 模块

| 文件 | 职责 |
| --- | --- |
| `src/api.ts` | 退出码常量、token 解析、base URL、`ApiClient`（GET/POST、错误分类） |
| `src/web.ts` | 管理路由、鉴权、请求体解析、错误映射；`webMessage` 生成 Router 消息 |
| `src/cli.ts` | 命令分发、`--json` 输出、退出码 |
| `src/status.ts` | `ticketJson`、`formatStatusBoard(snapshot)`、心跳判定 |
| `src/router.ts` | `retry` 命令、`pauseExecutor`/`resumeExecutor`/`executorState`、`fill` 门闩 |
| `src/store.ts` | `taskByEvent`、`failed → queued` 重排 |

## 3. 关键决策

### 对外叫 ticket，内部仍叫 task

API 资源名与验收一致（`/tickets`），内部类型、表名、状态机不动。`ticketJson` 是 `taskJson` 加 `statusLabel`，投影只有一份。

### CLI 不做客户端校验仓库

仓库别名、白名单、git 校验留在 Router（服务端）。CLI 只做参数形状校验，避免两套规则。代价是错误经 API 返回后按 `code=config` 映射成退出码 3。

### 服务常开

`web.enabled` 原本控制「是否起 HTTP」。CLI 一旦依赖 API，就必须永远有一个本地端口。于是服务端无条件绑定，`web.enabled` 退化为「是否开放 `/ui`」。端口被占用时不退出：任务执行比控制面重要，CLI 会得到 1。

### token 落文件

`PISA_WEB_TOKEN` 便于部署时固定；没有环境变量时写到 `<stateDir>/api.token`（0600，`wx` 创建处理竞争）。CLI 与服务端调同一个 `apiToken(cfg)`，谁先启动都能建出同一个 token，不需要用户手工同步。

### 只认请求头

`?token=` 会出现在 shell 历史、进程参数与日志里。API 只认 `x-pisa-token`/`Bearer`；浏览器的 `/ui` 是唯一例外——URL 里带一次 token 就能打开页面，页面用请求头调 API。

### 退出码按下一步动作划分

| 码 | 含义 | 典型场景 |
| --- | --- | --- |
| 0 | 正常 | 查询成功、派活成功、任务成功、回滚完成 |
| 1 | 需重启 | 连不上服务、心跳过期、合并成功待重启 |
| 2 | 部件错误 | 404、409、5xx、任务失败、等待超时、用法错误 |
| 3 | 待配置 | 配置文件缺失、401、仓库/白名单未配置 |

用法错误归 2：它同样是「这次调用不对」，脚本重试不会变好。

### 重试 = 恢复或重排

paused 复用 `handleResume`（要求工作副本存在、并发有空位）；failed 显式 `transition(failed → queued)` 并清空 `error`/`sessionId`/时间戳，由 `fill` 重新领走。取消与成功不提供重试：前者语义是放弃，后者该走 rewind。

### 暂停写进 meta

执行器暂停跨重启保持，落在 `meta.executor.paused`；`Router` 构造时读取，`fill` 首行判断。恢复时立即触发一次 `fill`，不必等下一个心跳周期。

### 合并仍需 `--yes` 之外的确认语义

IM 里 `/pisa merge` 本身就是显式动作，CLI 同样不需要额外 flag；HTTP 层保留 `confirm:true` 防止误发。rewind 破坏性更强，CLI 要求 `--yes`，不带时调 `confirm:false` 只取计划。

## 4. 风险

- 管理服务与 webhook 都监听本地端口，端口冲突时只记错误；CLI 得到 1，URL/端口在配置里可改。
- 测试进程内起真实服务，端口用 0 交给系统分配，`PISA_API_URL` 指过去，避免固定端口冲突。
- `PISA_SUPERVISED=1` 时合并会 `process.exit(1)`，测试必须清掉该环境变量。
- `formatStatusBoard` 改为接收快照后，Router 与 CLI 的输入同源，观感差异只可能来自心跳字段。
