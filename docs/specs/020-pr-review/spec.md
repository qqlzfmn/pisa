# 020 · PR 自动评审

- 状态：implemented
- 关联：`src/github-watcher.ts`、`src/github.ts`、`src/pr-review.ts`、`src/router.ts`、`src/store.ts`

## 1. 问题

pisa 能从 GitHub 评论接收任务，但不能主动评审代码：`GithubWatcher` 每轮只拉 Issue 评论，仓库里新开的 PR 不会被发现。没有评论的 PR 永远不会进入 pisa 的流程，PR 评审只能靠人。

## 2. 需求

- FR-001 配置 `github.review.enabled` 控制开关，缺省关闭；关闭时不拉 PR 列表、不建任务。
- FR-002 开关打开后，每轮轮询列出目标仓库的 open PR，读取 head SHA。
- FR-003 对尚未评审过的 `(仓库, PR 编号, head SHA)` 建一个评审任务；任务标记为 review 模式。
- FR-004 评审任务只读：不检出仓库、不建 worktree/分支、不交付、不推送、不创建 PR。评审依据是 PR diff。
- FR-005 结论以评论回帖到对应 PR；任务失败或取消不回帖。
- FR-006 同一 `(仓库, PR 编号, head SHA)` 只评审一次，跨进程重启仍成立（去重记录落库）；同一 PR 的 head SHA 变化后重新评审。
- FR-007 diff 拉取失败时不建任务，下一轮重试；不产生半成品任务。
- FR-008 现有评论入口行为不变：关闭评审不影响 `/pisa` 评论派活。

## 3. 非目标

- 不检出 PR 代码、不运行测试、不做编译验证；评审只基于 diff 文本。
- 不接 GitHub webhook 的 PR 事件，沿用现有轮询模型。
- 不做多轮对话式评审：结论一次回帖，后续追问走普通 PR 评论派活。
- 不区分 draft PR。

## 4. 验收

1. 开关关闭（或缺省）时，轮询不调用 `gh pr list`，不新建任务。
2. 开关打开且存在未评审 PR 时，建一个 review 任务；任务正文包含 PR diff 与只读约束。
3. 同一 PR、同一 head SHA 重复轮询只建一个任务；新建 watcher 实例（模拟重启）也不重复建。
4. 同一 PR 的 head SHA 变化后，下一轮建新任务。
5. review 任务成功后，摘要以评论回帖到 PR；执行过程不创建分支、不产生 worktree、不调用交付。
6. diff 拉取失败时本轮不建任务；下一轮成功后再建。
