# 014 · 实现计划

## 决策

### D1 评审是任务的一种类型，不是新流程

`Task.mode: "work" | "review"`，随任务落库（`mode TEXT NOT NULL DEFAULT 'work'`，旧库 `ALTER TABLE` 补列）。理由：排队、并发、取消、日志、恢复、回帖、状态板都已有实现，评审只改「建副本」「验收」「交付」三处分支。另起一条流程会复制状态机与调度 (FR-005)。

### D2 评审走独立入口，不进命令解析

`IncomingMessage.reviewPr = { number, headSha, title, baseRef }`，Router 在别名解析后立刻分流到一个私有方法，直接建任务。理由：评审的提示词由 pisa 生成，用户文本不存在；走 `parseCommand` 只会让触发词、任务守则误伤 (FR-005/FR-010)。

### D3 去重键带 head 提交，双层

进程内 `Set<string>` 以 `repo#pr@sha` 记录已投递，库内沿用 `store.claimEvent` 占位，`eventId = github:pr-review:<repo>:<n>:<sha>`。理由：进程内集合让每轮不重复发消息；事件占位让重启后不重复建任务。head 提交进键，rebase 前同一提交不会二次评审 (FR-006)。

### D4 副本用分离 HEAD，优先本次事件公告的提交

`git fetch origin +pull/<n>/head:refs/pisa/review/<n>`，若公告的提交已在库内则检它，否则检 fetch 到的引用值，然后 `git worktree add --detach`。理由：评审必须对「公告的那份代码」负责；推新提交后旧提交已不可 fetch，此时只能评最新提交，日志会不同。不用 `FETCH_HEAD`，因为它被并发 fetch 共享；不删引用，避免同 PR 并发评审时互相踩掉 (FR-007)。

### D5 只读靠三处叠加，不靠模型自觉

1. 评审任务的副本用后即删，不建分支、不推送、不建 PR（`deliverer` 不参与）；
2. 提示词限定只读并禁止改动工作副本；
3. `PISA_READONLY=1` 环境变量让 worker 扩展拦截写文件与 `git commit/push/checkout/reset/apply/clean` 等工具调用。

理由：提示词只是约定，扩展拦截是硬约束，副本丢弃是最后一道兜底 (FR-007/FR-008)。

### D6 验收标准按类型分支

工作任务的验收仍是「有文件改动」，评审任务的成功标准是运行完成，`runTask` 在交付前按 `mode` 分流。理由：评审本来就可能得出「无需改动」的结论，用改动量判定会把正常评审判成失败 (FR-008)。

### D7 仓库别名映射进 GitHub 配置

`github.repos[].alias`：评审任务在别名对应的本地仓库检出；评论任务也改用它（原本固定默认仓库）。理由：审核的对象必须是 GitHub 上那个仓库，别名是唯一能表达「同一个仓库」的配置位 (FR-002/FR-010)。

### D8 开关只管拉取，不管已建任务

`github.review.enabled` 关闭后不再调用 PR 列表接口；已经在跑的任务不打断。理由：中断运行中的任务会留下半截回帖与工作副本，关闭应当是「不再产生新任务」 (FR-001/FR-009)。

## 测试策略

- `tests/pr-review.test.ts`：
  - `listOpenPulls` 的命令参数与解析（含草稿标记）
  - 评审提示词包含 PR 号/标题/head 提交/只看不改的约束；回帖正文含短提交并截断
  - Watcher：新 PR 建一条评审任务；同 head 再轮询数量不变；head 变化后新增；草稿跳过；开关关闭时 PR 列表接口零调用
  - 端到端：裸远程仓库带 `refs/pull/1/head`，worker 从工作目录读到只有 PR 才有的文件，任务成功、工作副本删除、无分支、远程引用不变、PR 下出现带标记的评审评论
  - worker 在工作目录写文件后任务仍成功，且本地与远程都没有新分支
  - 配置了别名时任务落到别名仓库
- `tests/adapter.test.ts`：评审任务的参数带只读约束，环境变量带 `PISA_READONLY=1`
- 全量 `bun test`、`bunx tsc --noEmit`

## 影响面

- `src/types.ts`：`TaskMode`、`Task.mode`、`IncomingMessage.reviewPr`
- `src/store.ts`：`mode` 列与迁移、`claimQueued` 允许空分支
- `src/config.ts`：`github.review`、`github.repos[].alias`
- `src/github.ts`：`listOpenPulls`、`reviewPrompt`、`formatReview`
- `src/git.ts`：`createReviewWorktree`
- `src/github-watcher.ts`：评审轮询与去重
- `src/router.ts`：评审入口、任务类型、运行与交付分支、回帖格式
- `src/adapters/omp.ts`、`extensions/pisa-worker.ts`：只读提示与硬拦截
- `tests/*`：任务字面量补 `mode`，新增评审测试
- `README.md`、`pisa.config.example.json`、`docs/specs/014-pr-auto-review/`
