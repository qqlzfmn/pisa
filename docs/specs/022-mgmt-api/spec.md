# 管理 API 与脚本化 CLI

## 背景

`pisa` 的外壳有两套：IM 命令与 Web 控制台。CLI（`src/cli.ts`）是第三套，但它越过了 HTTP 层直接读写 SQLite：

1. `status`、`list`、`show`、`logs`、`wait`、`cancel` 都直接打开 `<stateDir>/pisa.db`，字段与状态机变更会同时要求改 Router、Web 和 CLI。
2. 合并、撤销、重试、暂停执行器只能在 Web 控制台或 IM 里做，脚本没法用。
3. 退出码是 CLI 私有的 0/1/2/3/4/5（任务失败、找不到、不可运行、超时），脚本与 agent 无法用一套统一语义判断"是配置问题还是部件问题"。

## 目标

- 本机管理接口补齐：状态快照、单任务详情、重试、取消、执行器暂停与恢复、仓库列表。
- CLI 的读与动作统一走 `http://127.0.0.1:<web.port>`，不再查表；只有建单（`run`、`continue`）留在本地，保证守护进程不在时仍能入队。
- 退出码收敛成四个语义：`0` 正常、`1` 需重启、`2` 部件错误、`3` 待配置。
- 所有 `--json` 输出可直接给脚本消费。

## 非目标

- 认证体系改造：沿用 Web token，只监听 `127.0.0.1`。
- CLI 建单改走 HTTP：离线入队是既有契约（`pisa run` 在心跳过期时仍入队并告警）。
- 新增 IM 命令或改变 Router 的命令语义。

## 边界

- **建单在本地**：`run`、`continue` 走 `Store.createTaskFromTrigger`（trigger 幂等账本），依赖数据库是队列写入路径，不是状态读取。
- **读与动作在 API**：其余命令一律经管理 API，CLI 不再引用 `Store`（`run`/`continue` 除外）。
- 浏览器会话用 cookie，CLI 与脚本用请求头；`?token=` 只用于 `/ui` 首次下发 cookie，不再对 `/api/*` 放行。

## 功能需求

- FR-001 `GET /api/state` 返回机器可读状态：`daemon`（`alive`/`ageMs`/`lastBeat`）、`counts`、`total`、`last24h`（`WindowMetrics`）、`worker`（`concurrency`/`running`/`paused`）、`repos`，以及 `text`（服务端渲染的看板文本，CLI 直接打印，避免第二套排版逻辑）。
- FR-002 `GET /api/tasks/:id?tail=N` 在既有详情上支持指定日志尾部行数，`N` 限制 1..2000，默认 200。
- FR-003 `GET /api/tasks` 增加 `status`、`limit`（1..200，默认 20）、`pr`、`githubRepo` 参数，并返回平铺 `tasks` 数组；看板三组字段保持不变，控制台不受影响。非法 `status` 返回 400。
- FR-004 `POST /api/tasks/:id/retry` 接受 `{ confirm: true }`，为终态任务新建一个任务：有分支的走 `continue` 语义（复用分支与上下文），没有分支的按原需求重新排队。`queued`/`running` 返回 409「任务仍在进行」；`paused` 返回 409 指向 resume；`succeeded` 返回 409 指向合并或撤销；`rewound`/`failed`/`cancelled` 允许重试。响应含新任务 `taskId`。
- FR-005 `POST /api/executor/pause` 接受 `{ confirm: true, paused?: boolean }`（缺省 `paused: true`）。暂停只停止领取新任务，运行中的任务照常结束；恢复后立即补位。返回 `{ ok, paused }`，状态同时出现在 `/api/state` 的 `worker.paused`。
- FR-006 `GET /api/repos` 返回仓库投影：`alias`、`path`、`remote`、`baseBranch`、`allowed`（是否在 `whitelist.repos` 内）。
- FR-007 Retry 与执行器暂停/恢复落审计：`action` ∈ `retry`、`executor.pause`、`executor.resume`。
- FR-008 `?token=` 只对 `GET /ui` 与 `GET /` 生效并下发 cookie；`/api/*` 与其它路径只接受 `Authorization: Bearer`、`x-pisa-token` 或 `pisa_web` cookie，否则 401。
- FR-009 CLI 命令：

  | 命令 | 通道 |
  | --- | --- |
  | `run <需求>`、`continue <任务号> <新要求>` | 本地入队（`--wait` 之后经 API 轮询） |
  | `status`、`list`、`show`、`logs`、`wait`、`repos` | `GET /api/state`、`GET /api/tasks`、`GET /api/tasks/:id`、`GET /api/repos` |
  | `cancel`、`retry`、`merge`、`rewind`、`executor pause\|resume` | `POST /api/tasks/:id/{cancel,retry,merge,rewind}`、`POST /api/executor/pause` |
  | `config`、`config --set <文件>` | `GET /api/config`、`POST /api/config` |

  `merge` 需要 `--yes`（快进主干），`rewind` 不带 `--yes` 只打印预览，`config --set` 需要 `--yes`。
- FR-010 退出码：

  | 码 | 含义 | 触发 |
  | --- | --- | --- |
  | 0 | 正常 | 命令成功；`--wait` 等到 `succeeded` |
  | 1 | 需重启 | `config --set` 保存成功且 `restartRequired: true` |
  | 2 | 部件错误 | 用法错误、API 不可达、动作被拒（409）、找不到任务、任务失败/取消/撤销、等待超时 |
  | 3 | 待配置 | 找不到配置文件、`web.enabled` 未开、token 环境变量缺失或不匹配 |

  配置未启用管理 API 时，读与动作命令返回 3 并提示开启 `web.enabled`；建单不受影响。

## 验收

1. `bun test` 通过；`bunx tsc --noEmit` 无错误。
2. Web 接口测试覆盖：`/api/state` 结构（含 `worker.paused`）、`status`/`limit` 过滤、`tail` 截断、retry 三种分流（有分支、无分支、在跑拒绝）、执行器暂停后 `drainOnce` 不领取任务、`/api/repos`、`?token=` 打 `/api/*` 返回 401。
3. CLI 测试用真实 `Bun.serve` + `createWebApp` 跑通：`status`/`list`/`show`/`logs` 的 JSON 与文本、`cancel`/`retry`/`merge`/`rewind`/`executor`/`config`、以及四个退出码各自的触发路径。
4. 越权路径有测试：错误 token（401 → 3）、缺 token 环境变量（3）、API 未启用（3）、无凭证请求（Web 测试 401）。
