# 021 · 管理接口与脚本化 CLI

- 状态：implemented
- 关联：014（agent CLI）、015（Web 控制台）、017（任务阶段）、018（健康指标）
- 依赖：`Store` 的 `meta` 表、`Router` 的命令链路、`ReplyBus`

## 1. 问题

pisa 的外部入口只有三条：IM、`POST /event` webhook、Web 控制台。脚本和 agent 想读状态、停任务、重试，只能拼 webhook，或者直接打开 SQLite 读 `tasks` 表——后者与内部表结构耦合，字段一改就坏；前者只能派活，不能读也不能停。

证据：

- `src/cli.ts` 的 `openState()` 直接 `new Store(join(cfg.stateDir, "pisa.db"))`，`status` / `show` / `logs` / `list` 全部读表；没有 HTTP 依赖。
- `src/web.ts` 只有 `/api/tasks` 一族路由；`docs/specs/017-task-stages/spec.md:67` 明确写着「pisa 没有独立的 /state 路由」。
- 没有执行器暂停：`Router.fill()` 只受 `stopping` 与 `worker.concurrency` 约束，停不下调度又不想杀进程时无接口可用。
- 失败任务只能人工重派；没有 `retry` 命令。
- `pisa` 的退出码按「任务失败 / 用法 / 找不到 / 不可运行 / 超时」分配，`1` 已表示任务失败，无法表达「守护进程没运行，需要重启」；`3` 已表示找不到，无法表达「待配置」。脚本无法据此分支。

## 2. 目标

- 状态、停止、重试、执行器开关走同一套本机 HTTP 接口，CLI 只是这套接口的客户端，不再读表。
- 接口只监听 `127.0.0.1`，一律要求请求头里的 token；token 由守护进程生成并写入 `stateDir/api.json`（0600），CLI 自动发现。
- 退出码可脚本化：`0` 正常、`1` 需重启、`2` 部件错误、`3` 待配置，其余保留细分。
- 新增 `retry` 与执行器暂停，IM 与 API 共用同一实现。

## 3. 用户故事

### US-1 脚本读状态

CI 脚本想知道「有没有任务在跑」：`pisa status --json` 直接拿 `{daemon, executor, counts, running, queued, finished, last24h}`；守护进程没启动时退出码为 `1`，脚本据此判断要不要先拉服务。

### US-2 agent 重试失败任务

agent 看到任务失败，调 `pisa retry <任务号> --json` 拿到新任务号；有分支的失败任务在原分支上续跑，没有分支的按原需求重开一条。

### US-3 暂停调度

维护窗口内不想让新任务抢 CPU：`pisa pause`，`/executor/pause` 停止补位，运行中的任务不受影响；`pisa run` 恢复。

### US-4 越权请求被拒

同一台机器上的其它用户拿到端口也调不动：没有 `x-pisa-token`（或 `Authorization: Bearer`）一律 401；`/state` 不接受查询参数里的 token。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 守护进程启动时在 `127.0.0.1:<web.port>`（默认 8787）上提供管理接口，与 Web 控制台共用服务与 token；实际 URL、token 与 pid 写入 `stateDir/api.json`（权限 0600）。token 优先取 `PISA_API_TOKEN`，其次 `web.tokenEnv`，都没有时随机生成；`web.port` 被占用且控制台关闭时退回系统分配端口，实际地址以 `api.json` 为准 |
| FR-002 | 管理路由只接受请求头凭证（`x-pisa-token` 或 `Authorization: Bearer`）；查询参数与 cookie 无效。`Host` 不是本机名时返回 403 |
| FR-003 | `GET /state` 返回 `{daemon:{alive,ageMs,lastBeat}, executor:{paused,running,queued,concurrency}, counts, total, running[], queued[], finished[], last24h}`，任务字段与 `TaskJson` 一致 |
| FR-004 | `GET /tickets/:id` 返回 `{task, effects, logTail}`；不存在返回 404 |
| FR-005 | `POST /tickets/:id/stop` 复用取消链路：queued / paused 直接置 cancelled，running 置取消请求；终态返回 409 |
| FR-006 | `POST /tickets/:id/retry`：failed / cancelled 可重试，返回新任务；有分支时续跑原分支，无分支按原需求新开；其它状态 409 |
| FR-007 | `POST /tickets/:id/merge` 复用 `/pisa merge`；请求体必须 `{confirm:true}`，否则 400；未成功合并返回 409 |
| FR-008 | `POST /tickets/:id/rewind` 预览返回 `{ok:true, plan}`；`{apply:true}` 执行撤销并返回 `{ok, status, message}`，以库内状态变为 `rewound` 判定成功；运行中任务返回 409 |
| FR-009 | `POST /executor/pause` / `POST /executor/resume` 切换持久化开关（`meta` 表）；`Router.fill()` 与 `drainOnce()` 在暂停时不补位，运行中的任务继续 |
| FR-010 | CLI 新增 `run`、`pause`、`stop`、`retry`、`merge`、`rewind`；`status`、`show`、`logs` 改为调用管理接口。`cancel` 重命名为 `stop`，不再保留 |
| FR-011 | CLI 的六个管理命令支持 `--json`，原样输出接口返回的 JSON（`logs --json` 仍是 `{task, effects, logTail}`） |
| FR-012 | CLI 退出码：`0` 正常、`1` 需重启（接口不可达或心跳过期）、`2` 部件错误（任务失败、HTTP 5xx、合并/撤销失败）、`3` 待配置（找不到 `api.json` / token、401/403）、`4` 用法、`5` 找不到、`6` 不可运行、`7` 等待超时 |
| FR-013 | 管理接口未配置或不可达时，`status` 等命令在 stderr 给出下一步（启动 pisa 或设置 `PISA_API_TOKEN`），不改读数据库 |

## 5. 验收

1. `GET /state`、`GET /tickets/:id` 返回契约字段；`id` 不存在时 404。
2. `POST /tickets/:id/stop|retry`、`POST /executor/pause` 生效：暂停后 `fill()` 不取任务，恢复后继续；重试生成新任务且不复制状态。
3. `pisa status|run|logs|merge|rewind --json` 输出可解析 JSON，退出码符合 FR-012。
4. 退出码 0/1/2/3 各有一条测试：正常、守护进程未运行、接口 5xx、待配置。
5. 无 token、错 token、查询参数 token、非本机 Host 均被拒。
6. `bun test` 与 `bunx tsc --noEmit` 通过。

## 6. 非目标

- 远程访问：接口不提供 TLS、不做反向代理适配；需要跨机时由使用者自行转发
- 多用户与权限分级：本地 token 持有者等同管理员
- CLI 的 `task` / `continue` / `wait` / `list` / `repos` 迁移到 HTTP：它们不依赖守护进程，保持离线可用
- Web 控制台改为调用新接口：`/api/tasks` 继续服务页面
