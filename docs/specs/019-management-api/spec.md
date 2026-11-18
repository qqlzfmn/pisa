# 019 · 管理接口与 pisa CLI

## 目的

`pisa` CLI 现在是一条独立通道：自己读配置、自己开 SQLite 写入任务、自己轮询表字段渲染看板。脚本与 agent 想读取系统状态只能拼 webhook，或者直接查库；`merge`、`rewind`、恢复这类动作只有 IM 命令入口。

本特性把「控制面」收敛成一份：守护进程在 `127.0.0.1` 上暴露管理接口，CLI 变成纯客户端。守护进程是唯一的写入口，CLI 不再依赖表结构，退出码成为可脚本化契约。

## 术语对齐

| 本特术语 | pisa 既有术语 | 说明 |
| --- | --- | --- |
| ticket | task | 任务 |
| stop | cancel | 动作名 `cancel`，终态 `cancelled`，与 IM 命令一致 |
| executor | Router 补位循环 | 执行器指 `Router.fill()` 的取任务循环 |

## 用户故事

1. 作为 CI 机器人，我调 `pisa status --json` 判断系统是否健康，退出码 0 就继续，1 就重启，不需要解析正文。
2. 作为运维，我在守护进程卡住时用 `pisa executor pause` 停掉取任务，处理完再恢复，不用杀进程。
3. 作为 agent，我用 `pisa task --wait` 提交任务并拿到结构化结果，失败时按退出码 2 走重试逻辑，不再解析中文回复。
4. 作为管理员，我只允许本机进程访问管理接口，任何非本机来源与错误 token 都被拒绝。

## 功能需求

| 编号 | 需求 |
| --- | --- |
| FR-001 | 守护进程启动时无条件监听 `127.0.0.1:<web.port>`，控制面常驻；`web.enabled` 只决定 `/ui` 与 `/` 是否可用 |
| FR-002 | `GET /api/state` 返回 `{ok, daemon, executor, counts, total, running, queued, finished, last24h, repos, text}`，`ok` = 心跳新鲜且执行器未暂停 |
| FR-003 | `GET /api/tasks` 支持 `repo`/`status`/`limit`/`pr` 过滤；`GET /api/tasks/:id` 返回任务、效果、日志尾部；`GET /api/tasks/:id/logs?tail=N` 单独取日志 |
| FR-004 | `POST /api/tasks` 投递需求（`prompt`、`repo?`、`eventId?`、`requester?`），幂等键与 IM 入口共用触发器账本 |
| FR-005 | `POST /api/tasks/:id/{cancel,resume,retry,continue,merge,rewind}`；`POST /api/executor/pause`（`{paused}`） |
| FR-006 | `retry` 生成新任务：复制需求、仓库、基线；原任务有分支与 PR 时落在同一分支与 PR（与续跑一致） |
| FR-007 | 错误响应 `{error, reason}`，`reason` 固定五值：`auth`（未认证）/`config`（配置、仓库、用法）/`state`（任务状态不允许）/`not_found`（任务不存在）/`component`（执行失败）；HTTP 状态按情形给 400/401/404/409，`reason` 是给客户端分支的依据 |
| FR-008 | `/api/*` 只接受请求头凭证（`Authorization: Bearer`、`x-pisa-token`、cookie）；query token 只用于 `/` 与 `/ui` 引导 |
| FR-009 | `pisa` 全部数据来自管理接口，不再读写 SQLite 业务表 |
| FR-010 | 命令集：`run`（别名 `task`，与 seed 里的「run」对应）、`continue`、`wait`、`status`、`list`、`show`、`logs`、`cancel`（别名 `stop`）、`resume`、`retry`、`merge`、`rewind`、`executor`、`repos`、`help`；除 `help` 外都支持 `--json` |
| FR-011 | 退出码：0 正常；1 需重启（控制面不可达、心跳过期、执行器暂停、任务 paused、等待超时）；2 部件错误（任务失败、动作被状态拒绝、合并/撤销失败、接口 5xx）；3 待配置（缺配置、缺 token 或 token 不符、仓库不可用、任务不存在、用法错误） |
| FR-012 | `pisa status` 在守护进程心跳过期或执行器暂停时返回 1，其余返回 0 |

## 非目标

- 不做远程访问与多用户鉴权：管理接口只服务本机，单 token。
- 不做任务重排/改需求接口；需求编辑仍由 IM 入口承担。
- 暂停执行器不持久化：重启即恢复，避免「忘记恢复」把队列冻住。

## 安全

- 绑定地址固定 `127.0.0.1`，不接受 `web.host` 配置。
- token 只从 `web.tokenEnv` 指定变量读取；缺 token 时 CLI 退出 3 并提示设置变量，不回退到随机 token 调用。
- token 比较走 `safeEqual` 常量时间；`/health` 保持免鉴权，只暴露聚合数字。

## 验收

1. `curl -H "Authorization: Bearer $PISA_WEB_TOKEN" 127.0.0.1:8787/api/state` 返回守护进程、执行器、队列与仓库；同一个请求带 `?token=` 返回 401。
2. `pisa status --json | jq .ok` 与接口一致；守护进程停止后 `pisa status` 退出 1。
3. `pisa task "修 x" --wait` 退出 0；worker 失败时退出 2；`pisa continue` 指向不存在任务退出 3。
4. 无 token 或错误 token 的请求返回 401 且 `reason: "auth"`，CLI 映射为 3。
5. `pisa executor pause` 后 `POST /api/tasks` 仍接单但不再开跑，`pisa executor resume` 后继续。
