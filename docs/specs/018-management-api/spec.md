# 018 · 管理接口与可脚本化 CLI

- 状态：implemented
- 关联：014-agent-cli（CLI 退出码契约）、015-web-console（本地 HTTP 外壳）、013-rewind（撤销语义）、010-status-board（看板投影）

## 1. 问题

守护进程的能力入口分裂在两侧：

- 状态：CLI 直接开 `pisa.db` 调 Store；Web 走 `/api/tasks`；两套读取路径都贴着内部表。
- 动作：`merge`、`rewind`、取消执行、停派新任务只有 IM 命令与 Web 控制台能做。脚本与 agent 想触发这些动作，只能自己拼 webhook 或模拟聊天消息。
- 结果：`pisa logs` 没有 `--json`，`pisa merge` / `pisa rewind` 不存在；脚本无法用命令行完成「合并—重启—继续」这类运维链路。

证据（改动前）：`src/cli.ts` 的 `openState()` 直接 `new Store(stateDir/pisa.db)`，命令表里没有 `merge`、`rewind`、`run`；`src/web.ts` 的路由只有 `/api/tasks`、`/api/tasks/<id>/cancel|merge`，没有 retry、stop、执行器暂停；`Router.fill()` 没有暂停开关。

## 2. 目标

- 守护进程独占的动作收敛到一套本机 HTTP 接口，CLI 与脚本都用它。
- CLI 提供 `status|run|logs|merge|rewind`，全部支持 `--json`，退出码可分支。
- 鉴权只有一条：请求头 token；监听只有一处：`127.0.0.1`。
- 读路径（status/list/show/logs）保留离线直读，守护进程不在时仍可查；不复制写逻辑。

## 3. 接口

所有接口要求 `x-pisa-token: <token>`，token 取自配置 `web.tokenEnv`（默认 `PISA_WEB_TOKEN`）。未带或错误返回 401。服务只监听 `127.0.0.1`。

| 方法 | 路径 | 别名 | 语义 |
| --- | --- | --- | --- |
| GET | `/api/state` | `/state` | 看板状态：`daemon`、`executor.paused`、`counts`、`repos`、`running`、`queued`、`finished` |
| GET | `/api/tasks` | | 与 `/api/state` 同一份 payload（Web 控制台沿用） |
| GET | `/api/tasks/<id>` | `/tickets/<id>` | 任务详情、副作用、日志尾部 |
| POST | `/api/tasks/<id>/retry` | `/tickets/<id>/retry` | 重新排队 |
| POST | `/api/tasks/<id>/stop` | `/tickets/<id>/stop` | 停止任务（与 `cancel` 同一处理） |
| POST | `/api/tasks/<id>/cancel` | | 停止任务（既有名字） |
| POST | `/api/tasks/<id>/merge` | | 合入主干，必须 `{"confirm": true}` |
| POST | `/api/tasks/<id>/rewind` | | 不带 `confirm` 只预览，`{"confirm": true}` 才执行 |
| POST | `/api/executor/pause` | `/executor/pause` | 停止领取新任务，执行中的任务不受影响 |
| POST | `/api/executor/resume` | `/executor/resume` | 恢复领取任务 |

`tickets` 与 `state` 是给外部脚本的别名，内部模型仍叫 task；别名在路由入口统一改写，不复制处理逻辑。

### 3.1 retry

只接受 `failed`、`cancelled`、`rewound`。新建一条任务：同 `repo`、`prompt`、`baseRef`、`context`、回帖目标，新 `id`、`source = retry:<原 id>`，状态 `queued`，分支与 PR 清空。原任务保持原状态与历史。返回 200 `{ok, taskId, message}`；任务不存在或状态不允许返回 409。

不修改原任务是为了保留失败证据；新任务走正常排队与并发槽位，不绕过 `fill()`。

### 3.2 执行器暂停

暂停状态写在 `meta.executor_paused`，是唯一真相源，重启后仍生效。`Router.fill()` 与 `drainOnce()` 在暂停时不领取任务；已运行任务继续到终态。`/api/state` 返回 `executor.paused`。

## 4. CLI

| 命令 | 行为 | 出口 |
| --- | --- | --- |
| `pisa status [--json]` | 直读本地库；JSON 增加 `executor.paused` | 0 |
| `pisa run <需求> [--wait] [--json]` | 与 `pisa task` 同一实现（同义命令） | 同 `task` |
| `pisa logs <id> [--tail N] [--json]` | 直读日志文件；JSON 为 `{id, lines}` | 0 / 3 |
| `pisa merge <id> [--json]` | POST `/api/tasks/<id>/merge`，带 `confirm: true` | 0/1/2/3 |
| `pisa rewind <id> [--yes] [--json]` | POST `/api/tasks/<id>/rewind`；`--yes` 才执行 | 0/2/3 |

`merge`、`rewind` 必须经过守护进程：合并要串行验证与快进，撤销要探测 PR 与分支，CLI 不复制这些判定。

### 4.1 退出码

管理命令（`merge`、`rewind`）：

| 码 | 含义 |
| --- | --- |
| 0 | 完成，无需重启 |
| 1 | 完成，但需要重启守护进程才生效（合并后） |
| 2 | 部件错误：接口拒绝、校验失败、5xx |
| 3 | 待配置：`web.enabled` 关闭、缺少 token、401/403、接口不可达 |

既有任务命令（`task/continue/wait/show/list/cancel/logs`）继续使用 014 的 0–5，不改语义：脚本已经在依赖它们。两套表在 `pisa help` 中分开列出。

## 5. 验收

1. `GET /api/state` 与 `GET /state` 返回同一份 payload，含 `executor.paused`
2. `GET /api/tasks/<id>`、`GET /tickets/<id>` 返回同一详情
3. `POST /api/tasks/<id>/retry` 生成排队新任务且原任务不变；不允许的状态 409
4. `POST /tickets/<id>/stop`、`/api/tasks/<id>/stop` 与 `cancel` 等效
5. `POST /api/executor/pause` 后 `drainOnce()` 不领取任务；`resume` 后恢复
6. 未带 token 的 state、retry、stop、pause 请求全部 401
7. `pisa merge` 成功退出 1（需重启）、被拒退出 2、未配置或缺 token 退出 3；`pisa rewind` 预览退出 0；`pisa logs --json` 输出 `{id, lines}`
8. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 不做远程访问、用户体系或多 token 权限；本机单人模型不变
- 不新增任务状态；retry 走新建任务而不是复活旧行
- 不把 `status/list/show/logs` 改成必须连守护进程；离线可读是刻意保留的能力
