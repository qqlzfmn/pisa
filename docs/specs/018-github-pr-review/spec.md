# 018 · GitHub PR 自动评审

- 状态：implemented
- 关联：006（PR 评论绑定）、017-trigger-thread（触发身份去重）
- 依赖：`github` 配置中已有仓库与 gh 认证

## 1. 问题

pisa 能从 PR 评论接活改代码，但不会主动看新 PR。评审仍要人打开 PR、读 diff、写意见。重复评审同一个 head 也没有成本约束：轮询重叠或进程重启都可能再次开单。

## 2. 目标

- 配置开关打开后，定时发现目标仓库的新 PR 或新提交，自动建评审任务
- 评审任务只读：不修改、不提交、不推送、不新建 PR
- 评审结论回帖到 PR，评审人在原处看到
- 同一 PR 的同一 head SHA 只评审一次，跨重启也成立
- 关闭开关时行为与现在一致

## 3. 用户故事

### US-1 新 PR 自动评审

作为维护者，打开 `github.review.enabled` 后，有人提新 PR，pisa 自动跑一轮评审，并在 PR 下回帖结论。

### US-2 新提交再评审

作为作者，我往 PR 推了新提交，head SHA 变了，pisa 对新版本再评审一次。

### US-3 不重复评审

作为维护者，轮询重叠、进程重启都不该让同一 head SHA 出现第二条评审结论。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `github` 配置新增可选 `review: { enabled: boolean }`，缺省关闭；关闭时不执行 PR 列表、diff 拉取与评审建单 |
| FR-002 | 开启后每轮轮询用 `gh pr list --repo <repo> --state open --json number,headRefOid,title,body,url` 拉取开放 PR |
| FR-003 | 对每个开放 PR，以线程键 `github:<repo>:pull:<n>`、消息键 `head SHA` 作为触发身份；已存在该触发记录时跳过，不再拉 diff、不再建任务 |
| FR-004 | 触发身份缺失时拉取 `gh pr diff <n> --repo <repo>`，失败只记日志，本轮不建任务，下一轮重试 |
| FR-005 | 评审任务的需求正文包含仓库、PR 号、head SHA、标题、描述与 diff；diff 超过 40000 字符时截断并注明 |
| FR-006 | 评审任务 `kind` 为 `review`，`replyPr` 指向 PR、`replyRepo` 指向仓库；不接续其它任务，不继承父分支 |
| FR-007 | 评审任务成功后跳过交付：不调用 deliverer、不推送、不建 PR；工作副本与自建分支删除，任务 `branch` 置空 |
| FR-008 | 评审 worker 若改动了工作副本，改动随工作副本一起丢弃，不进入仓库 |
| FR-009 | 评审成功后把摘要回帖到 PR，标题为 `**pisa** 评审结论`，正文截断到 3000 字，带隐藏标记 `<!-- pisa:reply task=<任务号> on=pr -->`，重复收尾不重复发 |
| FR-010 | PR 列表、diff、回帖失败不影响其它仓库与评论轮询；任务状态不因回帖失败改变 |
| FR-011 | Worker 提示词在评审任务中明确只读，并禁止提交、推送、创建或更新 PR、自行发评论 |
| FR-012 | 评审任务的建单、去重仍走 `triggers` 表，与评论、IM 入口共用同一套幂等逻辑 |

## 5. 验收

1. 给定 `github.review.enabled=true`，`gh pr list` 返回 PR 12（head `a`），轮询后存在一个 `kind=review` 的任务，`replyPr=12`、`replyRepo=o/r`，正文含 `#12`、`a` 与 diff
2. 给定同一 PR 同一 head `a` 连续两轮返回，两轮后只有一个任务
3. 给定 PR 12 的 head 从 `a` 变为 `b`，下一轮新增一个任务；再轮询不变
4. 给定 `github.review.enabled=false` 或缺省，轮询不调用 `gh pr list`，不产生评审任务
5. 给定评审 worker 在工作副本写入文件并成功返回，任务仍为 `succeeded`，不调用 deliverer，本地无 `pisa/<任务号>` 分支，工作副本被删除
6. 给定评审任务成功且绑定 PR 12，向 PR 12 回帖一次，正文以 `**pisa** 评审结论` 开头并以隐藏标记结尾
7. 给定 `gh pr diff` 失败，本轮不建任务；下一轮成功后建任务
8. 给定同一 head 的任务已存在，重启 Watcher 后不重复建任务

## 6. 非目标

- GitHub 的 review event、行内评论、批准或请求修改
- 已关闭或已合并 PR 的补评审
- 通过 webhook 实时监听 PR 事件；仍按轮询间隔发现
- 评审结果自动合并或自动改代码
