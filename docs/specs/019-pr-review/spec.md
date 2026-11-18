# 019 · PR 自动评审

- 状态：implemented
- 关联：006（PR 评论绑定）、011（多仓库轮询）
- 依赖：006/011 的 `gh` 轮询、触发器去重与回帖

## 1. 问题

pisa 能接任务改代码，但不能审代码。GitHub 上新建的 PR 需要人工逐条读 diff；评审结论也散落在 chat 里。现有 watcher 只在评论里出现触发词时才动作，没有任何「发现新 PR 就评审」的入口。

## 2. 目标

- 配置开关打开后，轮询目标仓库的开放 PR，新 PR 建一个只读评审任务
- 评审结论作为评论回到该 PR
- 同一 PR 的同一 head SHA 只评审一次；同一 PR 的新提交按新 SHA 重新评审
- 只读任务不提交、不推送、不建 PR、不改动 PR 内容

## 3. 用户故事

### US-1 新 PR 自动评审

作为维护者，我打开 `github.review.enabled`，此后仓库里新建的 PR 会自动出现一条 pisa 评审评论。

### US-2 新提交重新评审

作为作者，我按评审意见改完并 push，新的 head SHA 会触发一次新的评审，旧结论保留。

### US-3 同一 SHA 不重复

作为维护者，轮询重叠、进程重启或 PR 信息编辑都不会让同一 head SHA 产生第二个评审任务。

### US-4 关闭开关没有副作用

作为维护者，我把 `github.review.enabled` 设回 false 后，不再发现新 PR，原有评论轮询与任务行为不变。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `github.review` 为可选配置对象，`enabled` 为布尔开关，缺省关闭 |
| FR-002 | 开关打开时，每轮评论轮询后按仓库拉取开放 PR（`gh pr list --state open`，最多 100 条）；拉取失败只记日志，不影响评论链路 |
| FR-003 | 每个仓库维护评审基线 `github:review:since:<repo>`（启动时刻初始化）：基线之前创建的 PR 只记录当前 head 作为已见基线，不建任务 |
| FR-004 | 每个 PR 的已评审 head 落在 `meta` 的 `github:review:<repo>#<n>`；与当前 head 相同则跳过，不同则建任务并在投递成功后更新 |
| FR-005 | 评审任务是普通任务，带 `readonly = true`、`reviewBase`（PR 目标分支），`threadKey = github:<repo>:review:<n>`，`messageKey = headSha`，`eventId = github:review:<repo>:<n>:<sha>`，`replyPr = n`、`replyRepo = <repo>` |
| FR-006 | 同一 (threadKey, messageKey) 由 `triggers` 二次去重：轮询重叠、重启重放都不产生第二个任务 |
| FR-007 | 评审任务的工作副本按 PR head SHA 建立；本地没有该提交时先 `git fetch origin pull/<n>/head` 并校验 SHA，目标分支的远端引用不存在时再 `git fetch origin <base>` |
| FR-008 | 评审任务不进入交付：不 commit、不 push、不建 PR；结束后删除工作副本与临时分支，回帖正文头部为 `**pisa** 评审结论` |
| FR-009 | 评审结论用既有回帖标记与 outbox 重试机制发到 PR；回帖失败不影响任务状态 |
| FR-010 | 评审任务的 Worker 环境注入 `PISA_READONLY=1`；guard 拒绝文件写入类工具与 git 写子命令（add/commit/merge/apply/restore/rm/mv/stash/cherry-pick/revert/am/worktree add） |
| FR-011 | 评审任务是只读的：失败时不重试同一 SHA（元数据已记录已发现），新 SHA 照常触发 |

## 5. 验收

1. 开关关闭时轮询只拉评论，不发 `gh pr list`
2. 开关打开、基线之后新建 PR：产生一个 `readonly` 任务，`replyPr`、`replyRepo`、`reviewBase` 正确
3. 同一 SHA 连续两轮轮询只产生一个任务；重启（新建 watcher 实例）后仍只有一个
4. 同一 PR 的 head SHA 变化产生第二个任务；`meta` 更新为新 SHA
5. 基线之前就存在的开放 PR 不建任务，其 head 被记为基线；之后 head 变化照常建任务
6. 评审任务成功后：不调用 deliverer、工作副本与 `pisa/<id>` 分支被删除，回帖正文以 `**pisa** 评审结论` 开头
7. 只读模式下 guard 拒绝 `git add` / `git commit`，仍放行 `git diff` / `git log`；文件写入类工具被拒绝

## 6. 非目标

- 对已有 PR 的历史回填评审（基线之前创建的 PR 不评审）
- 评审意见以 review comment / approve / request changes 形式提交（只发普通评论）
- 按仓库自定义评审提示词或模型
- 只读任务的会话续跑与 `/pisa continue`
