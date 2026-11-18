# 018 · 实施计划

## D1 去重只认 `triggers`

PR 评审的去重键是 `threadKey = github:<repo>:pull:<n>`、`messageKey = head SHA`。Watcher 在建单前用 `store.triggerByMessage` 跳过已存在的 head；Router 的 `createTaskFromTrigger` 再做一次事务内去重。不新增 `meta` 游标，避免出现第二份「评审过没有」的真相源。

`head SHA` 变化即新消息，会建新任务；同一 SHA 无论轮询重叠还是进程重启都命中旧触发记录。

## D2 diff 在 Watcher 拉好，随需求正文下发

Worker 默认拿不到 `GH_TOKEN`（`DEFAULT_ENV_ALLOW` 不含凭据），不能假设它能执行 `gh pr diff`。Watcher 用 `gh pr diff` 拉 diff，拼进任务正文；超过 40000 字符截断并注明。评审任务仍能读本地仓库，但只读。

`gh pr list` 与 `gh pr diff` 失败只影响当前 PR/当前轮，不推进任何游标，也不阻塞评论轮询。

## D3 `Task.kind` 区分普通任务与评审

`tasks` 增加 `kind TEXT NOT NULL DEFAULT 'task'`，旧库用 `PRAGMA table_info` 补列。`Task.kind` 在类型上可选，旧测试构造的字面量按普通任务处理。

评审任务复用现有 `replyPr` / `replyRepo` 回帖路径，但成功收尾在 `runTask` 里提前分流：

1. 不调用 `deliverer.deliver`
2. `store.transition(..., { summary, branch: null })`
3. 删除工作副本与自建分支
4. 用 `formatReviewReply` 回帖

这样即使 Worker 改了文件，改动也随工作副本删除，不会推送或建 PR。

## D4 回帖标题独立

`formatReply` 保持普通任务标题；新增 `formatReviewReply` 输出 `**pisa** 评审结论`。两者共用 3000 字截断与隐藏标记，回帖幂等仍由 `postReplyOnce` 保证。
