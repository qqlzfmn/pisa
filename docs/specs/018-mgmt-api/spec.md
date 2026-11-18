# 018 · 管理 API 与 CLI 契约

- 状态：implemented
- 关联：014（Agent CLI，本次改写其传输层与退出码）、010（状态板）、013（rewind 账本）
- 取代：014 FR-013 的退出码表与「CLI 直接读写 SQLite」；015 FR-005~010 的 `/api/tasks*` 路径；017 中「没有独立的 `/state` 路由」的表述

## 1. 问题

CLI 直接打开 `pisa.db`：读状态、建任务、取消都依赖内部表结构，表一变客户端就碎；`merge`、`rewind` 没有 CLI 入口，脚本只能拼 webhook；执行器也不能暂停。退出码里 `1` 表示「任务失败」，无法表达「改动要在新进程里生效」。agent 与 CI 需要的是一套稳定契约，而不是一份可以被随意重构的表。

## 2. 目标

- 守护进程暴露一组 JSON 接口，只监听 `127.0.0.1`、只按请求头鉴权。
- CLI 是这套接口的瘦客户端：不再打开 SQLite，也不再自己判断状态跃迁。
- 退出码收敛为四档：`0` 正常、`1` 需重启、`2` 部件错误、`3` 待配置。
- 执行器可暂停/恢复，暂停状态落库，重启后保持。

## 3. 用户故事

### US-1 脚本查状态

作为 CI 脚本，我运行 `pisa status --json`，拿到心跳、执行器暂停与并发、三段任务列表；不再解析 SQLite。

### US-2 重试失败任务

作为 agent，我对 `failed` 的任务运行 `pisa retry <id> --json`，拿到新任务号；原任务保持不可变。

### US-3 运维停闸

作为维护者，我运行 `pisa pause`，执行器不再领取新任务，运行中的任务照常收尾；`pisa resume` 恢复。

### US-4 自举合并

作为发布脚本，我运行 `pisa merge <id> --json`；成功时退出码 `1`，据此重启或等待 supervisor。

### US-5 未配置

作为第一次接入的用户，我没设 `PISA_WEB_TOKEN` 就调用 CLI，得到退出码 `3`，stderr 明确指出要设置哪个变量。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `GET /state`：`daemon`、`executor{paused,running,concurrency}`、`counts`、`total`、`repos`、`repo`、`running`、`queued`、`finished` |
| FR-002 | `GET /tickets/:id`：`ticket`、`effects`、`logTail`；不存在返回 404 |
| FR-003 | `POST /tickets/:id/stop`、`POST /tickets/:id/retry`，语义与 IM 的 `cancel` / 重投一致 |
| FR-004 | `POST /executor/pause`，body `{paused?: boolean}`，缺省 `true`；恢复用 `{paused:false}` |
| FR-005 | 支撑 CLI 的其余接口：`GET /tickets`、`GET /tickets/:id/logs?tail=N`、`POST /tickets`、`POST /tickets/:id/{continue,merge,rewind}` |
| FR-006 | 鉴权：只绑 `127.0.0.1`；API 只认请求头（`Authorization: Bearer`、`x-pisa-token`、`HttpOnly` cookie）；查询参数 token 仅用于 `/ui` 引导，出现在 API 上直接 401 |
| FR-007 | 暂停落库 `meta.executor.paused`；`Router.fill()` 在暂停时不再领取任务；重启后保持 |
| FR-008 | `retry` 只接受 `failed` / `cancelled`；有分支时走 `continue`（`baseRef=父分支`，上下文由 `continuationContext` 生成），无分支按新任务重投；返回新任务，不改原任务 |
| FR-009 | `stop`：`queued`/`paused` 立即 `cancelled`，`running` 只登记取消请求 |
| FR-010 | CLI 命令：`run`（`task` 同义）、`status`、`list`、`show`、`logs`、`retry`、`stop`（`cancel` 同义）、`merge`、`rewind`、`continue`、`wait`、`pause`、`resume`、`repos`、`help`；全部支持 `--json` |
| FR-011 | CLI 传输：`cfg.web.port` + `cfg.web.tokenEnv`；`--url` 覆盖地址；缺配置文件、缺 token、401/403 都归为待配置 |
| FR-012 | 退出码：`0` 正常；`1` 需重启（`merge` 成功）；`2` 其它失败（任务失败、找不到、HTTP/网络错误、用法错误）；`3` 待配置（配置文件、token、白名单、仓库不可用） |
| FR-013 | `merge` 成功时响应 `restartRequired: true`，CLI 以 `1` 退出 |
| FR-014 | 错误响应 `{ok:false,error,reason}`，`reason ∈ config/not_found/conflict/invalid/error`；CLI 据此映射 `2`/`3` |

## 5. 验收

1. `GET /state` 与 `GET /tickets/:id` 返回上述字段；不存在的任务 404。
2. `POST /tickets/:id/stop` 取消排队任务；`POST /tickets/:id/retry` 为失败任务生成新任务且 `baseRef` 等于原分支；`POST /executor/pause` 后 `Router` 不再领取任务，`/state.executor.paused=true`，重启后仍为 `true`。
3. `pisa status|run|logs|merge|rewind --json` 输出可解析 JSON。
4. 退出码：正常 `0`；`merge` 成功 `1`；任务失败或 HTTP 错误 `2`；缺 token、错 token、缺配置 `3`。
5. 无 token 的 API 请求 401；API 上的 `?token=` 同样 401；只有请求头或 cookie 放行。
6. 测试覆盖四种退出码与越权访问。

## 6. 非目标

- 远程访问、多用户、TLS；需要时自己加反向代理
- 任务 attempt 表：`retry` 生成新任务，原任务不可变
- UI 视觉改版；只改接口路径与字段名
