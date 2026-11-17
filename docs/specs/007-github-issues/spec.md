# 007 · GitHub Issue 评论绑定

- 状态：implemented
- 关联：006（GitHub PR 评论绑定）把评论分流的类型判断补全；README 的「GitHub PR 评论」扩展为 Issue 评论
- 依赖：006 的轮询、去重、回帖机制

## 1. 问题

006 把所有带触发词的评论都当成 PR 评论处理：只要 `issue_url` 里有编号，就按「PR 号」绑定回帖，并尝试续跑该 PR 的既有任务。

实际上 GitHub 的评论接口同时覆盖 Issue 与 PR，两者的编号在同一个序列里。普通 Issue 上的 `/pisa` 评论因此会：

- 被 `gh pr comment` 回帖，命令失败；
- 被误判为「PR 无成功任务」，任务本身能建，但语义错误；
- 无法说明「这次改动关掉了哪个 Issue」。

Issue 是需求入口，PR 是实现产物，两者需要区分：Issue 评论开一个新任务（不带父分支），完成后回帖到 Issue，并由后续 PR 用 `Closes #<n>` 关联。

## 2. 目标

- Issue 评论与 PR 评论分开处理：PR 继承 006 的续跑语义，Issue 从主干开新分支
- 同一个编号先判定类型，再决定投递内容
- Issue 来源的任务完成后回帖到 Issue，失败只记日志
- Issue 来源的任务创建 PR 时在正文追加 `Closes #<n>`，让合并 PR 自动关闭 Issue
- 类型判定失败不产生错误绑定，也不推进轮询下界

## 3. 用户故事

### US-1 从 Issue 派活

作为维护者，我在 Issue 下评论 `/pisa 补一个导出接口`，系统从主干开新分支执行，完成后把摘要回帖到该 Issue。

### US-2 PR 评论语义不变

作为评审人，我在 pisa 产出的 PR 下评论 `/pisa 再改一处`，系统仍然接续原分支与原 PR，不因本次改动改变行为。

### US-3 自动关联

作为维护者，我希望 Issue 派生的任务在创建 PR 时带上 `Closes #<n>`，合并 PR 后 Issue 自动关闭。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 提供编号类型判定：调用 `gh api repos/<repo>/issues/<n> --jq '.pull_request // empty'`，输出非空即 PR，输出为空即普通 Issue；命令失败返回错误结果，不抛出 |
| FR-002 | 轮询到带触发词的评论后，先按 `issue_url` 取编号，再判定类型 |
| FR-003 | 判定为 PR 时沿用 006 的行为：`continueFrom` 指向该 PR 最近的成功任务（没有则为空），`replyPr` 为该编号 |
| FR-004 | 判定为普通 Issue 时投递一条只带 `replyIssue` 的消息：不带 `continueFrom`、不带 `replyPr`，任务从主干开新分支 |
| FR-005 | 同一条评论（GitHub 评论 id）仍然最多产生一个任务，与类型无关 |
| FR-006 | 类型判定失败时该条评论本轮不投递，记录日志，并让本轮不推进增量下界 |
| FR-007 | 任务完成后若 `replyIssue` 非空，用 `gh issue comment <n> --repo <repo> --body <摘要>` 回帖；正文格式与 PR 回帖一致（超过 3000 字截断），末尾追加隐藏标记 `<!-- pisa:reply task=<任务号> on=issue -->` |
| FR-008 | Issue 回帖失败只记日志，任务状态与回执不变 |
| FR-009 | 任务来自 Issue（`replyIssue` 非空）且新建 PR 时，PR 正文追加一行 `Closes #<n>`；正文其余部分为空也不得产生残缺格式 |
| FR-010 | 任务信息持久化 `reply_issue` 列；已有数据库启动时自动补列，历史任务该列为空 |
| FR-011 | Issue 回帖与 PR 回帖共用 006 FR-014/FR-015 的幂等规则：发送前查 `<repo>#<n>` 讨论串，已有同标记则跳过；用途不同的标记（`on=pr` / `on=issue`）互不抑制 |

## 5. 验收

1. 给定评论 `/pisa 补一个导出接口`、`issue_url` 为 `.../issues/20`、`gh api .../issues/20` 输出为空，轮询后产生一个任务：需求正文为 `补一个导出接口`，`replyIssue` 为 20，`replyPr` 为 null，`baseRef` 为 null
2. 给定同一评论落在 `.../issues/12` 且 `gh api .../issues/12` 输出 `pull_request` 对象（非空），当 PR 12 已有成功任务 A，新任务 `continueFrom` 为 A、`branch` 与 `prUrl` 沿用 A
3. 给定 PR 12 没有成功任务，评论产生普通任务，`replyPr` 为 12、`replyIssue` 为 null
4. 给定同一评论被两轮轮询返回，只存在一个任务
5. 给定 `gh api .../issues/<n>` 非零退出，本轮不投递该评论、不推进下界，下一轮可重新处理
6. 给定任务成功且 `replyIssue` 为 20，收尾时执行一次 `gh issue comment 20 --repo <repo> --body <摘要>`；失败时任务仍为成功，日志含失败原因
7. 给定任务 `replyIssue` 为 20 且没有既有 PR，创建 PR 时正文含 `Closes #20`
8. 给定历史数据库没有 `reply_issue` 列，启动后 `Store` 读写该字段正常

## 6. 非目标

- 主动监听 Issue 的开立、关闭、标签变化（只处理评论）
- Issue 与 PR 之间的任务链继承（Issue 任务不寻找父任务）
- 编号类型缓存：每条候选评论各查一次，接受额外 API 调用
- 回帖内容的智能排版（只回摘要）
