# 006 · 实现计划

- 输入：`spec.md`
- 约束：不改 `extensions/`；不引入新依赖；轮询与解析全部用 `gh` CLI，不直连 HTTP

## 1. 技术决策

| 决策 | 结论 | 依据 |
| --- | --- | --- |
| 配置 | `Config.github?: { enabled; repo; intervalSec?; tokenEnv?; chatId; userId }`，`repo` 形如 `owner/repo` | 与 `webhook` / `proactive` 一致：可选段，缺省不启用（FR-001） |
| 拉取 | `gh api "repos/<repo>/issues/comments?since=<iso>&per_page=100" --paginate --jq '.[]'` | PR 评论与 Issue 评论同一接口；`--paginate` 覆盖多页，`--jq '.[]'` 把每页摊成一行一个对象，避免多页数组拼接后无法解析（FR-002） |
| 解析 | 逐行 `JSON.parse`，取 `id`、`body`、`issue_url`、`user.login` | 一行失败即整体失败并保留错误文本，不猜字段（FR-010） |
| 鉴权 | `tokenEnv` 指向的环境变量在启动时写入 `GH_TOKEN` | `gh` 只认 `GH_TOKEN` / `GITHUB_TOKEN`；pisa 已有「token 走环境变量」的约定（FR-001） |
| 模块划分 | 新增 `src/github.ts`：纯函数 + 可注入 `Runner`（`(args) => {code,out,err}`），错误返回结果对象；新增 `src/github-watcher.ts`：定时器 + 增量下界 | 纯函数可直接单测，不联网；与 `Worker`/`Deliverer` 的可注入风格一致（FR-002/FR-010） |
| 增量下界 | 落库在 `meta` 表的 `github:since:<repo>`：构造时读游标，缺失才用启动时刻初始化并写入；每轮成功后才推进到「本轮开始时刻」 | 游标是进度状态，只活在内存会让 supervisor 重启、部署或机器重启期间的评论永久丢失；失败不推进避免漏评论；成功推进用轮询开始时刻而非结束时刻，避免轮询期间的新评论被跳过（FR-002/FR-003/FR-010） |
| 触发词 | `cfg.trigger + " "` 前缀，正文先 `trim` | 触发词只有一个来源（config），行为与 spec FR-004 一致 |
| 去重 | 传给 `Router.handle` 的 `eventId` 固定为 `github:comment:<id>`，由 Router 既有的 `store.claimEvent(eventId, taskId)` 落库 | Router 是唯一的建任务入口，也在建任务前占键；watcher 再占同一键会把键消耗掉、导致 Router 丢弃该评论。故去重只保留一处（FR-005） |
| 续跑绑定 | `IncomingMessage` 增加可选 `continueFrom`（父任务号）与 `replyPr`（回帖目标）；Router 复用 `continue` 的分支/上下文构造 | 不另开任务创建路径；`continue` 命令路径与 PR 评论路径共用同一段父任务校验与上下文格式（FR-006） |
| 权限 | PR 评论以配置的 `userId` 投递，因此不走「只有原请求者可以续跑」；IM 的 `continue` 仍保留该校验 | 评论作者是 GitHub 身份，与 IM 白名单无对应关系（spec 非目标） |
| 回帖 | `Task.replyPr` 落库（tasks 表新增 `reply_pr INTEGER`，含轻量迁移）；`runTask` 在写 `succeeded` 后调用 `postComment`，正文由 `formatReply(summary)` 生成（截 3000 字） | 回帖是任务收尾动作，放在状态写入之后；失败只 `TaskLogger.write`，不改状态（FR-008/FR-009） |
| 回帖幂等 | `replyMarker(taskId, purpose)` 生成隐藏注释，`postReplyOnce` 先查讨论串（`repos/<repo>/issues/<n>/comments`，`--jq '.[]'` 逐行取正文）再发；已有标记返回 `skipped`，检查失败返回错误且不发 | 幂等键用任务号：任务收尾只会发生一次，重跑复用同一号；检查失败时漏发可重跑补救，重复发不可撤销（FR-014/FR-015） |
| 装配 | `index.ts` 创建 watcher，`enqueue = (m) => router.handle(m)`；shutdown 里 `watcher.stop()` | 与 `Proactive` 的装配方式一致（FR-011） |

## 2. 影响面

- `src/config.ts`：`Config.github` 可选段
- `src/github.ts`（新）：`Runner`、`listComments`、`postComment`、`postReplyOnce`、`replyMarker`、`prNumberFromIssueUrl`、`formatReply`
- `src/github-watcher.ts`（新）：`GithubWatcher`
- `src/types.ts`：`IncomingMessage.continueFrom` / `replyPr`，`Task.replyPr`
- `src/store.ts`：`reply_pr` 列与迁移、`taskByPr`
- `src/router.ts`：续跑解析接受 `continueFrom`、建任务写入 `replyPr`、成功后回帖
- `src/index.ts`：装配与关停
- `pisa.config.example.json`、`README.md`

## 3. 测试策略

全部用假 `Runner` 与假 `ChannelAdapter`，不联网、不跑 `gh`：

- 纯函数：`prNumberFromIssueUrl` 的 issue/pull/带查询串/非法输入；`formatReply` 的截断边界
- 轮询：假 runner 返回固定评论列表，断言只对触发词评论投递、投递字段（eventId/channel/chatId/userId/text/continueFrom/replyPr）
- 去重：真实 `Store(":memory:")` + `Router.handle`，同一评论两轮轮询后任务数为 1
- 续跑绑定：PR 已有成功任务时，新任务的 `baseRef` 与 `context`
- 回帖：假 runner 断言先查讨论串再 `gh pr comment` 的参数顺序、正文截断与隐藏标记；讨论串已有标记时不发、检查失败时不发

## 4. 风险

- `gh api --paginate --jq` 的行为依赖 gh 版本；解析失败会记为错误并保留原输出，不会误建任务
- `postComment` 是同步子进程调用，阻塞事件循环数十到数百毫秒；单任务收尾时发生，可接受
- 评论作者不做鉴权：能评论仓库的人都能触发任务，前提是仓库权限本身已受限（spec 非目标）
