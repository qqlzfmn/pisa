# 018 · 管理 API 与 CLI

- 状态：implemented
- 关联：001（任务状态机）、010（状态板）、013（rewind）、017（outbox effects）、014-agent-cli（被本篇取代）
- 依赖：Bun、SQLite（守护进程独占写）

## 1. 问题

管理动作没有统一的本地接口：

- CLI 直接 `new Store(...)` 读写 SQLite，与 `tasks`、`meta`、`effects` 表结构耦合；表一变，CLI 跟着改。
- 脚本与 agent 想重试中断任务、暂停执行器、合并或回滚，只能拼 webhook 或直接改库。
- 退出码 0–5 混合了用法错误、任务失败、找不到、不可运行、超时，脚本无法区分「需要重启」与「配置没做完」。

web 控制台已经有一套 `/api/tasks*`，但它是给浏览器用的：看板字段、cookie 鉴权、没有状态与执行器入口。再长第二套接口就是架构分叉。

## 2. 目标

- 守护进程提供唯一的管理 API：状态、任务详情、重试、停止、合并、回滚、执行器暂停。
- CLI 只是该 API 的客户端，不再接触数据库。
- 退出码按「脚本下一步该做什么」划分：0 正常、1 需重启、2 部件错误、3 待配置。
- 仅监听 127.0.0.1，鉴权只认请求头。

## 3. 用户故事

### US-1 脚本判断守护进程是否在跑

CI 运行 `pisa status --json`，读 `daemon.alive`；退出码 1 表示进程没在跑或需要重启，2 表示接口报错，3 表示配置缺失。

### US-2 agent 重试中断任务

`POST /tickets/:id/retry`：暂停的任务恢复执行，失败的任务重新排队；拿到 409 就说明状态不允许重试。

### US-3 运维暂停执行器

`POST /executor/pause` 之后不领取新任务，运行中的任务继续；`/state` 能看到 `executor.paused`。

### US-4 合并后重启

`pisa merge <id> --json` 合并成功返回 `restartRequired: true` 与退出码 1；脚本据此重启守护进程加载新代码。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 守护进程总是启动管理服务（`127.0.0.1:<web.port>`）；`web.enabled` / `--web` 只决定 `/ui` 是否可访问；端口占用只记错误，不阻塞任务执行 |
| FR-002 | 鉴权只认 `x-pisa-token` 或 `Authorization: Bearer`；API 路径忽略 `?token=`；`/ui` 与 `/` 可用 `?token=` 做浏览器引导 |
| FR-003 | token 解析顺序：`process.env[web.tokenEnv]` → `<stateDir>/api.token`（0600，缺失时创建）；CLI 与服务端共用 `apiToken()` |
| FR-004 | `GET /state?repo=` 返回 `daemon`、`executor`、`counts`、`total`、`repos`、`repo`、`running`、`queued`、`finished` |
| FR-005 | `GET /tickets?repo=&status=&pr=&githubRepo=&limit=`、`GET /tickets/:id`、`GET /tickets/:id/logs?tail=` |
| FR-006 | `POST /tickets {prompt,repo?,continueFrom?,eventId?,requester?}`：派活与续跑，返回 `ticketId`、`ticket`、`message`、`daemon`；空正文 400 |
| FR-007 | `POST /tickets/:id/stop`：排队/暂停直接取消，运行中登记取消请求，终态 409 |
| FR-008 | `POST /tickets/:id/retry`：暂停恢复执行（要求工作副本存在、并发有空位），失败重新排队；其它状态 409 |
| FR-009 | `POST /tickets/:id/merge {confirm:true,force?}`：成功返回 `restartRequired: true`；未确认 400，不满足合并条件 409 |
| FR-010 | `POST /tickets/:id/rewind {confirm}`：`confirm:false` 只返回计划；`confirm:true` 执行回滚 |
| FR-011 | `POST /executor/pause`、`POST /executor/resume`：状态写入 `meta.executor.paused`，重启后保持；暂停期间 `fill` 不领取新任务 |
| FR-012 | 错误体 `{ok:false,error,code?}`，code ∈ `unauthorized`/`config`/`not_found`/`state`；对应用 400/401/404/405/409/500 |
| FR-013 | CLI 命令：`run`、`continue`、`wait`、`status`、`list`、`show`、`logs`、`stop`、`retry`、`merge`、`rewind`、`repos`；全部支持 `--json` |
| FR-014 | CLI 通过 `http://127.0.0.1:<web.port>` 访问 API；`PISA_API_URL` 可覆盖（仅接受 loopback） |
| FR-015 | 退出码：0 正常；1 需重启（API 不可达、心跳过期、合并成功）；2 部件错误（4xx/5xx、任务失败、等待超时、用法错误）；3 待配置（配置文件缺失、401、仓库未配置） |
| FR-016 | `status --json` 在 API 不可达时仍输出 `{ok:false,daemon:{alive:false,…},error}` 并退出 1 |
| FR-017 | IM 新增 `/pisa retry <id>`（别名「重试」），与 API 共用重试语义 |
| FR-018 | 状态机新增 `failed → queued`；`docs/architecture.md` 跃迁表同步 |

## 5. 验收

1. `GET /state`、`GET /tickets/:id` 返回任务与执行器状态；未知任务 404
2. `POST /tickets/:id/retry` 对 failed 任务重新排队、对 paused 任务恢复执行；queued 任务 409
3. `POST /tickets/:id/stop` 取消排队任务；对已成功任务 409
4. `POST /executor/pause` 后新任务保持 queued，`/state.executor.paused=true`；`resume` 后继续领取
5. 无 token、错误 token、`?token=` 访问 API 均 401；仅请求头放行
6. `pisa status --json`：心跳新鲜退出 0，心跳过期退出 1，接口不可达退出 1，配置缺失退出 3
7. `pisa run "改文案" --json`（心跳新鲜）退出 0 并输出任务号；心跳过期退出 1
8. `pisa logs --json`、`pisa show --json`、`pisa list --json`、`pisa stop --json`、`pisa retry --json` 输出 JSON 并返回 0；目标不存在返回 2
9. `pisa merge <id> --json` 合并成功退出 1 且 `restartRequired=true`；`pisa rewind <id> --json` 未加 `--yes` 只输出计划并退出 0
10. 现有测试全绿；新增覆盖上述退出码与越权路径

## 6. 非目标

- 远程访问、TLS、多用户账号体系
- CLI 直接读写 SQLite（本篇移除）
- 自动重启守护进程
- 取消任务的 retry（只支持 paused/failed）
