# 015 · Web 控制台 Phase 1：任务看板、派活、取消/合并、日志

- 状态：specified
- 关联：README「用法」中的 `/pisa status`、`docs/specs/010-status-board`（看板数据来自同一份快照语义）
- 依赖：011 多仓库（仓库筛选与派活的目标仓库来自同一份仓库配置）

## 1. 问题

pisa core 的全部能力目前只能经聊天通道使用：定位任务、看日志、对比状态都要翻聊天记录，效率低且不直观。`/pisa status` 是一条会随新消息滚走的文本，`.pisa/logs` 是原始文件，任务详情（prompt 全文、分支、PR、日志尾部）没有统一的查看入口。

## 2. 目标

- 本机浏览器打开一个页面，就能回答：谁在跑、跑了多久、排了多少、最近结果如何
- 不离开页面完成三个写操作：派活、取消、合并
- 未持有 token 的请求一律拒绝（401），服务只监听 127.0.0.1
- 单页实现，不引入前端框架、不增加构建步骤

## 3. 用户故事

### US-1 看全局

作为 pisa 的所有者，我打开 `/ui`，看到运行中、排队、最近完成三组任务，以及总数、成功、失败、暂停四个数字和守护进程心跳状态。

### US-2 按仓库筛选

作为维护多个仓库的所有者，我选择某个仓库别名后，三组列表只剩该仓库的任务。

### US-3 看任务详情

作为所有者，我点一条任务，看到它的 prompt 全文、状态、耗时、分支、PR 链接和日志尾部。

### US-4 派活

作为所有者，我在页面上选仓库、写需求并提交，得到一个任务号，任务进入排队，之后可以由守护进程执行。

### US-5 取消与合并

作为所有者，我在页面上取消还没结束的任务；对已完成的任务执行合并，合并前必须在界面上二次确认。

### US-6 复制任务号

作为所有者，我一键把任务号复制到剪贴板，粘到聊天或终端里继续用。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 守护进程启动时，若 `web.enabled` 为真，在 `127.0.0.1:<web.port>` 提供 HTTP 服务；`bun run web` 以同样的默认值直接启动带 Web 控制台的守护进程 |
| FR-002 | `GET /ui` 返回单页控制台 HTML；`GET /` 重定向到 `/ui` |
| FR-003 | 除 `/health` 外的路由要求 token：请求携带 `?token=`、`Authorization: Bearer`、`x-pisa-token` 头或 `pisa_web` cookie 之一；缺失或不匹配返回 401。`/health` 是监控采集入口，不鉴权，见 018-health-metrics |
| FR-004 | `GET /ui?token=<token>` 用 `Set-Cookie` 记住 token，之后的同源请求不再需要 URL 参数 |
| FR-005 | `GET /api/tasks?repo=<别名>` 返回 `{ daemon, counts, total, repos, running, queued, finished }`；`repo` 只过滤三个列表，不过滤汇总计数 |
| FR-006 | 任务 JSON 字段：`id`、`status`、`repo`、`prompt`、`branch`、`prUrl`、`createdAt`、`startedAt`、`endedAt`、`duration`（人类可读，运行中按当前时间算）、`summary`、`error` |
| FR-007 | `GET /api/tasks/<id>` 返回 `{ task, logTail }`；日志尾部取 `.pisa/logs/<id>.log` 的最后 200 行，`{ts,stage,msg}` 行格式化为 `HH:MM:SS stage msg`，解析失败原样保留；任务不存在返回 404 |
| FR-008 | `POST /api/tasks` 接收 `{ prompt, repo? }`，按 IM 派活同一套路径（仓库/用户白名单、事件去重、入队）建任务，返回 `{ ok, taskId, message }`；空 prompt 返回 400 |
| FR-009 | `POST /api/tasks/<id>/cancel` 走与 `/pisa cancel` 相同的判定；返回 `{ ok, status, message }`，运行中任务只置取消请求也算成功 |
| FR-010 | `POST /api/tasks/<id>/merge` 走与 `/pisa merge` 相同的校验、临时副本测试与快进合并；请求体必须带 `confirm: true`，否则返回 400；结果以是否落下 `merge` 副作用判断 |
| FR-011 | 页面展示三组表格：任务号（可点开详情、可复制）、耗时、仓库、需求单行预览、PR 链接、操作按钮；取消与合并按钮按状态出现 |
| FR-012 | 取消与合并都在浏览器里弹确认框；合并确认后的请求带 `confirm: true` |
| FR-013 | 页面每 5 秒自动刷新三组列表与计数，写操作进行中暂停自动刷新；详情面板不自动刷新，提供手动刷新按钮 |
| FR-014 | 页面正文全部用 `textContent` 构造，prompt 与日志里的 HTML 不会被解释 |
| FR-015 | web 入口视作已认证的本地操作者：跳过单英文词误触防护，并且不受「只有原请求者可以取消/合并」限制 |
| FR-016 | 控制台与管理接口（021）共用 `127.0.0.1:<web.port>` 与 token；`web.enabled` 只决定 `/ui` 是否开放，管理路由始终可用 |

## 5. 验收

1. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/ui`（无 token）→ `401`
2. 带正确 token 打开 `/ui` → 200，返回 HTML，并下发 `pisa_web` cookie
3. `GET /api/tasks` 返回三组列表与计数；带 `repo=<别名>` 时列表只剩该仓库
4. 对一个有日志的任务 `GET /api/tasks/<id>` → 返回 prompt、分支、PR、耗时与日志尾部
5. `POST /api/tasks {prompt:"修一下登录"}` → 任务落库为 `queued`，响应带 `taskId`
6. `POST /api/tasks/<id>/cancel` → 排队任务变为 `cancelled`
7. `POST /api/tasks/<id>/merge` 不带 `confirm` → 400；带 `confirm: true` → 分支合入主干，`task_effects` 出现 `merge`
8. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 远程访问、多用户、HTTPS、登录页
- 实时推送（SSE/WebSocket）、日志流式滚动
- 续跑、恢复、撤销三个命令的界面入口
- 定时任务、主动发现、GitHub 评论的配置管理
- 分页、全文搜索、按请求者筛选
