# 006 · 任务拆分

- [x] T1 `Config.github` 可选段与示例配置 (FR-001)
      验证: `tsc --noEmit`；`pisa.config.example.json` 含 github 段
- [x] T2 `src/github.ts`：`prNumberFromIssueUrl` / `listComments` / `postComment` / `formatReply`，`Runner` 可注入，错误走结果对象 (FR-002/FR-004/FR-008)
      验证: `bun test tests/github-comments.test.ts`（`prNumberFromIssueUrl`、`listComments / postComment`、`formatReply` 三组）
- [x] T3 `Task.replyPr` + `reply_pr` 列与轻量迁移 + `taskByPr` (FR-006/FR-008)
      验证: `bun test tests/github-comments.test.ts`（去重/续跑用例建库即走迁移）
- [x] T4 Router：`continueFrom` / `replyPr` 入参，复用 continue 的分支与上下文构造 (FR-006/FR-007)
      验证: 「PR 已有成功任务时接续它的分支」「PR 没有成功任务时按普通任务处理」
- [x] T5 Router：任务成功后回帖，失败只记日志 (FR-008/FR-009)
      验证: 「任务成功后向来源 PR 回帖」「回帖失败只记日志，任务仍成功」「未启用 github 时不回帖」
- [x] T6 `src/github-watcher.ts`：定时轮询、触发词过滤、增量下界、去重投递 (FR-002…FR-005/FR-010/FR-011)
      验证: 「只处理触发词开头的评论，并按 PR 号投递」「同一评论轮询两轮只建一个任务」「拉取失败时不建任务、不推进下界；成功后推进」
- [x] T7 `index.ts` 装配 watcher 与 `GH_TOKEN`、关停停止轮询 (FR-001/FR-011)
      验证: `tsc --noEmit`；`bun test` 全绿
- [x] T8 README 增加「GitHub PR 评论」小节
      验证: 人工检查 README 正文
- [x] T9 评论续跑的分支/PR 语义：继承父任务分支与 prUrl、只清理自建分支、复用 PR 不再新建、分支占用明确失败 (FR-006/FR-012/FR-013)
      验证: `bun test tests/router.test.ts tests/github-comments.test.ts`；`tsc --noEmit`
- [x] T10 回帖幂等：`replyMarker` / `postReplyOnce` 先查讨论串再发，已有同标记跳过，检查失败不发 (FR-014/FR-015)
      验证: `bun test tests/github-comments.test.ts`（`postReplyOnce` 组、「讨论串已有同标记时跳过回帖」）；`tsc --noEmit`
- [x] T11 游标落库：`Store.getMeta/setMeta`（`beat`/`lastBeat` 复用同一实现），watcher 以 `github:since:<repo>` 读写增量下界，缺失才用启动时刻初始化 (FR-003/FR-010)
      验证: `bun test tests/github-comments.test.ts`（「预置游标优先于启动时刻」「重启后沿用落库游标」「旧库没有游标时以启动时刻为界」「拉取失败时不建任务、不推进下界」「一个仓库失败不推进自己的下界」）；`tsc --noEmit`
- [x] T12 同一 PR 只有一条工作线：`Store.activeTaskByPr`、Watcher 优先投递进行中的父任务、Router 对未结束父任务占位事件并提示一次 (FR-016)
      验证: `bun test tests/github-comments.test.ts tests/router.test.ts`（「PR 有进行中的任务时不再另开工作线，只提示一次」「父任务成功后新评论正常续跑」）；`tsc --noEmit`
