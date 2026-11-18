# 015 · 方案

## 1. 结构

```
脚本/agent ──pisa CLI──HTTP(127.0.0.1 + x-pisa-token)──> 管理服务（守护进程内）
                                                            │
                                            ┌───────────────┼────────────────┐
                                          Router          Store          日志文件
                                            │
                                 Worker / GitDeliverer / gh

IM / webhook / GitHub 评论 ──> Router.handle ──> 同一批管理方法
```

- CLI 只做三件事：读配置定位 `stateDir`、读 `<stateDir>/api.json` 拿端口与令牌、发 HTTP。
- 管理服务是 `Router`/`Store` 的薄 HTTP 层；业务规则在 Router 的公开方法里，IM 与 HTTP 共用。
- 状态机唯一入口仍是 `Store.transition`。

## 2. 模块

| 文件 | 职责 |
| --- | --- |
| `src/management.ts` | 管理契约：`ManagementError`、`taskView`、`stateView`、`api.json` 读写、请求/响应类型 |
| `src/api.ts` | `startManagementApi`：Bun.serve、令牌鉴权、路由分发、状态码映射 |
| `src/api-client.ts` | `ManagementClient`：读 `api.json`、发请求、把网络错误与 HTTP 错误分成 `DaemonError` / `ApiError` / `ConfigError` |
| `src/router.ts` | 新增 `createTicket` / `retryTicket` / `stopTicket` / `mergeTicket` / `rewindTicket`；`handleCancel` / `handleMerge` / `handleRewind` 改为薄包装 |
| `src/store.ts` | `setExecutorPaused` / `executorPaused`（`meta` 表） |
| `src/status.ts` | `statusSnapshot` 继续供 API 使用；`taskView` 移到 `management.ts` |
| `src/cli.ts` | 参数解析、命令分发、文本输出、退出码 |
| `src/index.ts` | 启动/停止管理服务，接进关停流程 |
| `src/config.ts` | `api: {enabled, port}`，默认启用、端口 7801 |

## 3. 接口

统一响应：成功为各自对象；失败为 `{ "error": "..." }`，状态码 `400/401/403/404/409/500`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 心跳、执行器暂停、计数、运行/排队/最近完成 |
| GET | `/tickets` | 过滤列表 |
| GET | `/tickets/:id` | 任务详情 |
| GET | `/tickets/:id/logs?tail=80` | 日志尾部 |
| POST | `/tickets` | 建单 `{prompt, repo?, requester?, eventId?}` |
| POST | `/tickets/:id/retry` | 失败/取消任务重试 |
| POST | `/tickets/:id/stop` | 取消/登记取消 |
| POST | `/tickets/:id/merge` | 验证并合并 |
| POST | `/tickets/:id/rewind` | `{execute?:false}` 预览或执行 |
| POST | `/executor/pause` | `{paused?:true}` |

## 4. 关键决策

### 用 `api.json` 发现地址与令牌，而不是写进配置

CLI 与守护进程必须共享令牌，令牌又不能进配置文件（会被提交）。`stateDir` 本来只对本机用户可读，`api.json` 用 `0600`，生命周期跟随进程：文件存在但连接失败就是「守护进程没起来」，对应退出码 1；文件不存在同理。端口允许配置为 0，测试可以并行起服务而不抢端口。

### 令牌只用于隔离，不做用户体系

管理 API 只在回环地址，攻击面是同机其它进程。随机 192 位令牌 + `timingSafeEqual` 足够；请求头复用 webhook 的 `x-pisa-token`，不引入第二套鉴权约定。

### 管理方法放在 Router，而不是 API 层

合并要读活动 Map、执行器要控制调度、重试要复用建单规则。这些只有 Router 持有。HTTP 层只做参数解析与状态码映射，IM 命令与 CLI 因此共享同一行为。

### 执行器暂停存 `meta`

暂停必须跨进程可见（CLI 写、守护进程读），又不值得新增表。`meta` 已有 key/value 结构；调度循环每 800ms 读一次，开销可忽略。暂停只拦 `fill()`，不打断运行中任务。

### 新退出码按“下一步动作”分组

0/1/2/3 对应「继续」「重启」「修故障」「改配置」，脚本不需要认识状态词。旧 3（找不到任务）与 4/5（不可运行/超时）都归入 2，因为都是本次命令失败，不需要改配置或重启。

### `run` / `stop` 改名

`task` 与 CLI 里的“任务”概念重复，`cancel` 与 Store 的取消请求语义（运行中只是登记）不一致。验收要求 `run`；因此一次性改掉，不做别名。

## 5. 风险

- **合并/验证阻塞请求**：合并会跑 `bun test`，HTTP 请求可能持续数分钟。CLI 不设请求超时，与原来同步等待一致；HTTP 客户端断开不影响服务端继续合并。
- **自举重启**：`PISA_SUPERVISED=1` 时合并成功后进程 800ms 后退出，响应需先写回。`mergeTicket` 返回结果后再调度退出，CLI 能拿到成功响应。
- **`api.json` 残留**：崩溃后文件仍在，CLI 连接失败落退出码 1，提示重启；下次启动覆盖。
- **暂停忘记恢复**：`GET /state` 与 `pisa status` 显式展示暂停状态，README 写明恢复命令。

## 6. 验证

- `tests/api.test.ts`：鉴权（缺失/错误/正确）、状态与详情、建单幂等、重试幂等与冲突、停止、暂停与恢复、合并/撤销的 404 与冲突、日志。
- `tests/cli.test.ts`：在临时仓库上启动管理服务，覆盖 `status`/`run`/`wait`/`logs`/`stop`/`retry`/`executor`/`merge`/`rewind` 与退出码 0/1/2/3。
- 现有路由、GitHub、rewind、调度测试保持通过。
- `bun test`、`bunx tsc --noEmit`。
- 手工：临时目录启动守护进程（`--channel cli`），另开 shell 跑 `pisa status --json`、`pisa run ... --wait`。
