# 015 · 管理 API 与脚本化 CLI

- 状态：implemented
- 关联：014-agent-cli（CLI 入口与 skill 包）、010-status-board（看板）、013-rewind（撤销账本）、001-router-worker（状态机）
- 依赖：守护进程、Bun HTTP 服务、SQLite

## 1. 问题

014 让 CLI 直接读写守护进程的 SQLite。这带来三个问题：

1. **耦合内部表**：`tasks`、`meta`、`task_effects` 的列一旦调整，CLI 与测试全部跟着改；CLI 事实上成了第二个状态机入口。
2. **绕过运行时**：取消运行中的任务只是写 `cancel_requested`，恢复、合并、撤销这类需要访问活动执行器与工作目录的操作，CLI 完全没有入口，脚本和 agent 只能拼 webhook 或去 IM 里点命令。
3. **退出码不可脚本化**：014 的 0–5 把「用法错误」和「配置错误」混在 2，把「找不到任务」独立成 3，脚本无法区分「要人改配置」「要重启守护进程」「部件真的坏了」。

守护进程已经持有全部运行时能力，应该由它暴露一套本地管理接口，CLI 只做 HTTP 客户端。

## 2. 目标

- 守护进程在回环地址上提供读写同一套能力的 HTTP 接口：状态、任务详情、提交、重试、停止、合并、撤销、执行器暂停。
- CLI 所有状态查询与写操作都走该接口，不再打开数据库。
- 退出码收敛为四类，脚本据此分支：0 正常、1 需要重启、2 部件错误、3 待配置。
- IM 命令与 HTTP 操作复用同一份业务实现，不出现两套状态机。
- 接口只接受本机连接，并要求请求头携带守护进程启动时生成的令牌。

## 3. 用户故事

### US-1 脚本查状态

作为 CI 脚本，我调用 `pisa status --json`，拿到守护进程心跳、执行器是否暂停、各状态计数与任务列表，不需要知道 SQLite 表结构。

### US-2 脚本停任务

作为运维，我调用 `pisa stop <任务号>`：排队任务立即取消，运行中任务登记取消请求，命令返回后脚本按退出码继续。

### US-3 失败重试

作为 agent，我 `pisa run "修 CI" --json` 拿到任务号，`pisa wait` 发现失败后执行 `pisa retry <任务号>`，得到新任务号；重复调用 `retry` 不会重复建单。

### US-4 暂停执行器

作为值班人，我 `pisa executor pause`，排队任务不再被领取，正在跑的任务不受影响；`pisa executor resume` 恢复派发。

### US-5 合并与撤销

作为维护者，我 `pisa merge <任务号>` 触发验证与 fast-forward 合并，`pisa rewind <任务号>` 先看预览，`--yes` 才执行。

### US-6 退出码分支

作为脚本，我只用四个数字判断后续动作：

- `0`：命令成功。
- `1`：管理接口不可达或心跳过期，需要重启/启动守护进程。
- `2`：接口返回错误、任务失败、等待超时、用法错误、鉴权失败。
- `3`：配置文件缺失、仓库未授权或不是 git 仓库、管理接口被关闭，需要先改配置。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 守护进程启动管理 HTTP 服务，监听地址固定 `127.0.0.1`，端口取 `api.port`（默认 `7801`，`0` 表示由系统分配） |
| FR-002 | 服务启动后把实际端口与随机令牌写入 `<stateDir>/api.json`（权限 `0600`），进程退出时删除；文件是 CLI 获知地址与令牌的唯一来源 |
| FR-003 | 除 `GET /` 外的所有请求必须携带 `x-pisa-token`，缺失或不匹配返回 `401` 且不解析请求体 |
| FR-004 | `GET /state` 返回 `daemon`（心跳状态）、`executor.paused`、`counts`、`total`、`running`、`queued`、`finished` 任务列表 |
| FR-005 | `GET /tickets` 支持 `repo`、`status`、`limit`、`pr`、`github-repo` 过滤，语义与 014 的 `pisa list` 相同 |
| FR-006 | `GET /tickets/:id` 返回单个任务，不存在返回 `404` |
| FR-007 | `GET /tickets/:id/logs?tail=N` 返回任务日志尾部行（默认 80，最多 10000）；任务不存在返回 `404`，任务存在但没有日志返回空数组 |
| FR-008 | `POST /tickets` 接收 `{prompt, repo?, requester?, eventId?}` 建排队任务；校验仓库别名、白名单与 git 仓库，事件键幂等，重复时返回原任务 |
| FR-009 | `POST /tickets/:id/retry` 为 `failed`/`cancelled` 任务建新排队任务（同仓库、同请求者、同需求，新任务号）；其它状态返回 `409`；同一任务重复重试返回第一次创建的新任务 |
| FR-010 | `POST /tickets/:id/stop`：排队/暂停任务直接转 `cancelled`；运行中且有活动执行器时登记取消请求并返回“取消中”；无活动执行器的运行中任务直接转 `cancelled`；终态返回 `409` |
| FR-011 | `POST /tickets/:id/merge` 执行“验证分支 → 主工作区 fast-forward 合并 → 记账”，返回 `{ok, detail}`；失败原因为业务原因时仍返回 `200` 与 `ok=false`，任务不存在返回 `404` |
| FR-012 | `POST /tickets/:id/rewind` 接收 `{execute?: boolean}`；缺省只返回撤销计划；`execute=true` 执行动作并返回计划与结果；状态不允许撤销返回 `409` |
| FR-013 | `POST /executor/pause` 接收 `{paused?: boolean}`（默认 `true`），持久化到数据库；暂停期间调度循环不领取排队任务，运行中任务不受影响 |
| FR-014 | 管理操作与 IM 命令共用同一实现：`/pisa cancel`、`merge`、`rewind` 只做参数解析、请求者校验与文本格式化 |
| FR-015 | CLI 命令：`status`、`run`、`continue`、`wait`、`list`、`show`、`logs`、`retry`、`stop`、`merge`、`rewind`、`executor pause|resume`、`repos`、`help`；原 `task` 更名 `run`，原 `cancel` 更名 `stop` |
| FR-016 | CLI 不再打开 SQLite；`status`、`run`、`continue`、`wait`、`list`、`show`、`logs`、`retry`、`stop`、`merge`、`rewind`、`executor` 全部通过管理接口；`repos` 与 `help` 只读配置文件 |
| FR-017 | CLI 的 `--json` 使用接口返回的任务/状态结构；`--wait` 轮询 `GET /tickets/:id`，间隔默认 1s，超时默认 1800s |
| FR-018 | 退出码映射固定：成功 `0`；`api.json` 缺失、连接失败、心跳过期 `1`；接口 4xx/5xx、任务失败或取消、等待超时、用法错误 `2`；配置文件缺失、管理接口未启用、仓库未授权/不存在/不是 git 仓库 `3` |
| FR-019 | `api.enabled=false` 时守护进程不启动管理服务；CLI 对管理命令返回退出码 `3` 并提示启用方法 |
| FR-020 | `GET /state` 的 `daemon.alive` 与 CLI 的退出码 1 判定使用同一份心跳逻辑（`HEARTBEAT_STALE_MS`） |

## 5. 验收

1. 启动管理服务后，`GET /state` 在带令牌时返回 `200` 与 `daemon`、`executor`、`counts`、`total` 字段；不带或带错令牌返回 `401`。
2. `POST /tickets` 建单后 `GET /tickets/:id` 可查到；同一 `eventId` 再次提交返回同一任务号。
3. `failed` 任务调用 `retry` 生成新 queued 任务；再次调用返回同一新任务号；`succeeded` 任务调用返回 `409`。
4. 排队任务调用 `stop` 后状态为 `cancelled`；已成功任务调用返回 `409`。
5. `POST /executor/pause` 后 `GET /state` 的 `executor.paused=true`，排队的任务不被领取；`{paused:false}` 后恢复派发。
6. `pisa status --json` 输出心跳与计数，且进程内没有打开 SQLite；守护进程未启动时返回退出码 `1`。
7. 配置文件缺失、仓库未授权、API 关闭时 CLI 返回退出码 `3`；守护进程未启动返回 `1`；任务失败、接口 404、参数错误返回 `2`；正常命令返回 `0`。
8. `pisa run`、`pisa logs`、`pisa merge`、`pisa rewind` 的 `--json` 输出可被 `JSON.parse`，字段与接口一致。
9. IM 的 `/pisa cancel`、`merge`、`rewind` 行为与改造前一致，现有路由测试通过。
10. `bun test` 与 `bunx tsc --noEmit` 通过。

## 6. 非目标

- 远程访问、TLS、多用户令牌、令牌轮换与权限分级（本机单用户，令牌只用于隔离同机其它进程）。
- 流式日志、WebSocket 推送。
- 替代 webhook：webhook 仍是外部事件入口，管理 API 不对外开放。
- 在 CLI 里执行 Worker、验证或合并逻辑；这些仍由守护进程完成。
- 兼容 014 的 `task` / `cancel` 命令名与 0–5 退出码。
