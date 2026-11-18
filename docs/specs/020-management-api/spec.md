# 020 · 管理 API 与 pisa CLI

- 状态：implemented
- 关联：014（agent CLI，退出码与命令集合被本规格替换）、015（Web 控制台，复用同一台 HTTP 服务）、010（状态看板）、013（rewind）
- 依赖：Bun HTTP 服务、SQLite（只由守护进程打开）

## 1. 问题

014 让 CLI 直接打开 SQLite 读写任务表：字段、状态机、去重全部复制一份，库结构一变 CLI 就要跟着改。脚本与 agent 因此被绑死在「和守护进程同机同库」上，唯一的结构化入口是 webhook——而 webhook 的语义是「投递事件」，不是「查询与操作」：拿不到任务详情，不能停止、重试、合并，也不能暂停派活。

Web 控制台有一套 `/api/tasks`，但它的鉴权照顾浏览器（query、cookie 都收），返回的是页面投影，不适合脚本直接消费。

## 2. 目标

- 一套本机 HTTP 接口承载查询与操作：状态、任务详情、派活、停止、重试、合并、撤销、暂停派活。
- CLI 变成这个接口的客户端，不再打开数据库；退出码可脚本化。
- 接口只监听 127.0.0.1，鉴权只认请求头。
- 写操作继续走 Router：白名单、事件去重、状态机、合并校验都只有一份。

## 3. 用户故事

### US-1 脚本查状态

CI 里跑 `pisa status --json`，解析 `daemon.alive`、`counts`、`running`，不接触数据库文件。

### US-2 agent 派活并等待

`pisa run "<brief>" --repo demo --event-id ci:42 --wait --json`：拿到任务号，阻塞到终态，按退出码分支。

### US-3 运维暂停派活

发布窗口内 `pisa pause`，队列不再出队；`pisa pause --resume` 恢复。运行中的任务不被打断。

### US-4 重试失败任务

`pisa retry <任务号> --wait`：同一需求、同一仓库再跑一遍，不复用可能已清理的旧分支。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/mgmt.ts`：管理路由、鉴权、JSON 投影与 token 落盘；`web.ts` 在 `/health` 之后、浏览器鉴权之前把管理路径交给它 |
| FR-002 | 路由：`GET /state`、`GET /tickets`、`POST /tickets`、`GET /tickets/:id`、`POST /tickets/:id/retry`、`POST /tickets/:id/stop`、`POST /tickets/:id/merge`、`POST /tickets/:id/rewind`、`POST /executor/pause` |
| FR-003 | 鉴权只接受 `Authorization: Bearer` 或 `x-pisa-token`；query 与 cookie 一律 401。`Host` 存在且不是 `127.0.0.1` / `localhost` / `::1` 时 403（DNS rebinding 防护） |
| FR-004 | token 由 `startWebServer` 写入 `<stateDir>/mgmt.token`（0600）；CLI 先读 `web.tokenEnv`，再读该文件 |
| FR-005 | `GET /state` 返回 `daemon`、`executor`（paused/active/concurrency）、`counts`、`total`、`repos`、`running`、`queued`（上限 50）、`finished`（20）、`last24h`；任务字段用 `TaskJson` |
| FR-006 | `GET /tickets/:id` 返回 `task`、`effects`、`logTail`（`?logTail=N`，1..500，默认 200） |
| FR-007 | `POST /tickets` 接受 `{prompt, repo?, continueFrom?, eventId?}`；重复 `eventId` 返回原任务；`continueFrom` 沿用 `continue` 命令语义 |
| FR-008 | `POST /tickets/:id/retry` 只接受终态任务，新建同 prompt/repo 的排队任务，`baseRef/branch/prUrl` 为空，`context` 由 `retryContext` 生成；运行中返回 409 |
| FR-009 | `POST /tickets/:id/stop` 复用 `cancel` 命令；queued/paused 直接取消，running 登记取消请求，终态 409 |
| FR-010 | `POST /tickets/:id/merge` 要求 `{confirm:true}`，可选 `force`；成功时返回 `restart: "auto"/"manual"`（`PISA_SUPERVISED=1` 为 auto） |
| FR-011 | `POST /tickets/:id/rewind` 默认只返回预览；`{confirm:true}` 才执行，未完成时 409 |
| FR-012 | `POST /executor/pause` 接受 `{paused:boolean}`；暂停只拦新任务，运行中的任务继续；状态不跨重启保留 |
| FR-013 | 管理端错误体 `{ok:false, code, error}`，`code` ∈ `usage`/`config`/`auth`/`state`；仓库/白名单类失败用 `config`，缺 token 或错 token 用 `auth` |
| FR-014 | `Router` 增加 `pauseExecutor` / `executorState` / `retryTask`；`fill()` 在暂停时不再出队 |
| FR-015 | CLI 重写为 HTTP 客户端：`status`、`run`、`continue`、`wait`、`show`、`list`、`logs`、`retry`、`stop`、`pause`、`merge`、`rewind`、`help`；不再打开 SQLite |
| FR-016 | 退出码：`0` 正常、`1` 需重启（merge 返回 `restart=manual`）、`2` 部件错误（连不上、4xx/5xx、任务失败/取消/撤销、超时、用法错误）、`3` 待配置（无配置文件、管理接口未启用、token 缺失或 401、`code=config`） |
| FR-017 | 文本状态板改由 `BoardView` 渲染：`/pisa status`、`pisa status`、`/state` 共用同一字段集合；`statusSnapshot` 删除 |
| FR-018 | `pisa merge` 必须显式 `--confirm`；`pisa rewind` 无 `--yes` 只预览 |

## 5. 验收

1. `GET /state` 带 token 返回完整快照；无 token、`?token=`、cookie 均 401；`Host: evil.example` 403
2. `GET /tickets/:id` 返回任务、副作用与日志尾部；不存在 404
3. `POST /tickets/:id/retry` 为 failed 任务建新任务（同 prompt/repo、无旧分支）；running 任务 409
4. `POST /tickets/:id/stop` 让 queued 变 cancelled；终态 409
5. `POST /executor/pause {paused:true}` 后排队任务不再启动，`false` 后继续；`GET /state.executor.paused` 一致
6. CLI 的 `status|run|logs|merge|rewind --json` 均只走 HTTP；`merge` 在非看护模式退出 1
7. 退出码 0/1/2/3 各有测试；错误 token 退出 3；越权凭证返回 401
8. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 不引入远程访问、TLS、多用户权限模型；管理接口只服务本机同用户
- 不改任务状态机与数据库表结构；暂停派活不写库
- 不替换 Web 控制台的 `/api/tasks`：浏览器仍用 cookie，脚本用 `/tickets`
