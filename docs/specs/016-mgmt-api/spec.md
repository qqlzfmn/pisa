# 016 · 管理接口与脚本化退出码

- 状态：implemented
- 关联：001（任务状态机）、013（rewind 账本）、014（agent CLI）、015（web 控制台）
- 依赖：Bun HTTP server（复用 015 的本机外壳）、SQLite

## 1. 问题

- CLI 是交互壳：状态与取消直接读写 SQLite，取消逻辑与 Router 各写一份。数据库里 running 但没有执行器的遗留行，CLI 只登记取消请求，任务不会再有执行器来消费它（Router 对同一情况会直接置 cancelled），CLI 却回答「已请求取消」。
- merge / rewind / retry / 暂停调度只能靠聊天命令或手拼 webhook；脚本没有稳定入口，也拿不到结构化结果。
- `logs` 没有 `--json`；`merge`、`rewind` 不在 CLI。
- `pisa status` 永远退出 0：脚本无法区分「配置没填」「部件坏了」「改了配置要重启」。

## 2. 目标

- 一个本机管理接口，状态、重试、停止、暂停调度都只走它；写操作仍由 Router 执行，不复制状态机。
- CLI 管理命令优先走该接口；接口不可用时只读命令回落本地库，提交任务仍直接写库（守护进程不在时也要能排队）。
- 退出码表达系统状态，看护脚本据此分支。

## 3. 术语映射

seed 用 tickets / executor，pisa 的既有词汇是 tasks / Router 调度器。接口路径沿用 pisa 词汇，不新增同义路径：

| seed | pisa |
| --- | --- |
| `GET /state` | `GET /api/state` |
| `GET /tickets/:id` | `GET /api/tasks/:id` |
| `POST /tickets/:id/retry` | `POST /api/tasks/:id/retry` |
| `POST /tickets/:id/stop` | `POST /api/tasks/:id/cancel`（取消） |
| `POST /executor/pause` | `POST /api/executor/pause` |

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `GET /api/state` 返回 `daemon`、`executor`、`health`、`counts`、`total`、`repos` 与 running/queued/finished 三组任务 |
| FR-002 | `GET /api/tasks/:id` 沿用 015：任务投影、副作用、日志尾部 |
| FR-003 | `POST /api/tasks/:id/cancel`、`/retry`、`/merge`、`/rewind` 由 Router 执行，响应带 `ok`、`code`、`status`、`taskId`（retry 新建的任务号）与 `message` |
| FR-004 | `POST /api/executor/pause`，body `{"paused":true|false}`；暂停只停止调度新任务，执行中的任务继续 |
| FR-005 | `/api/*` 只接受 `Authorization: Bearer` 或 `x-pisa-token` 请求头；`?token=` 仅用于浏览器首次打开 `/ui`；不再下发 `pisa_web` cookie |
| FR-006 | 服务仍只监听 127.0.0.1，token 仍来自 `web.tokenEnv` |
| FR-007 | 管理动作的退出码语义：0 成功、1 管理接口不可达（需重启/启动守护进程）、2 操作失败（部件错误）、3 前置条件缺失（任务不存在、仓库未配置、token 未设置）、4 任务状态不允许（沿用既有 cancel/merge 语义） |
| FR-008 | `src/health.ts`：健康检查返回 `{code, issues[]}`，代码 3 待配置 > 2 部件错误 > 1 需重启 > 0 正常 |
| FR-009 | 守护进程启动时把 `configHash(cfg)` 写入 `meta["config.hash"]`；健康检查用当前磁盘配置比对，不一致即「需重启」 |
| FR-010 | 健康检查的部件项：仓库路径不是 git 仓库、`worker.command` 找不到；配置项：没有仓库、`whitelist.users` 为空、web/telegram/github 启用但缺 token、有 schedules 但缺 scheduler 身份 |
| FR-011 | `Router.retryTask(id)` 从 failed/cancelled/rewound 任务派生新任务（同仓库、同 prompt、全新分支），事件 id `retry:<id>`，重复调用返回同一任务 |
| FR-012 | `pisa status` 优先用管理接口（含执行器暂停状态与 daemon 侧健康结论），否则本地计算；退出码取 `health.code` |
| FR-013 | CLI 新增 `run`（同 `task`）、`logs --json`、`merge <id>`、`rewind <id> [--yes]`、`retry <id>`、`executor pause|resume`；均支持 `--json` |
| FR-014 | CLI 管理命令退出码：接口不可达 1、操作失败 2、前置条件缺失 3；`cancel` 走接口时把「状态不允许」映射为 4（与既有 `cancel` 语义一致） |
| FR-015 | 接口不可达时 `merge`/`rewind`/`retry`/`executor` 直接失败，不回落本地实现，避免两套状态机 |

## 5. 验收

1. 开启 web 后 `curl -H "x-pisa-token: $PISA_WEB_TOKEN" 127.0.0.1:8787/api/state` 返回 `health.code`、`executor.paused` 与任务分组
2. 不带请求头、或带 `?token=` 访问 `/api/state` 均 401；带正确请求头 200
3. `POST /api/executor/pause {"paused":true}` 后排队任务不再被认领，`{"paused":false}` 后恢复
4. failed 任务 `POST /retry` 产生新的 queued 任务；再次调用返回同一任务号
5. `pisa status` 在健康配置下退出 0；配置改过后退出 1；仓库路径损坏退出 2；仓库为空/缺 token 退出 3
6. `pisa merge <id> --json`、`pisa rewind <id> --json --yes` 输出 `{ok,code,message,...}`，失败返回 2
7. 未开 web 时 `pisa retry <id>` 退出 1 并提示用 `--web` 或 `web.enabled` 启动

## 6. 非目标

- 不引入 `/tickets` 同义路径，也不把 `tasks` 改名
- 不做远程（非 127.0.0.1）监听、不做多用户鉴权、不做登录页
- 不把 executor 暂停状态持久化：守护进程重启即恢复调度
- 不改变 014 已有的任务命令退出码语义（0/1/2/3/4/5）
