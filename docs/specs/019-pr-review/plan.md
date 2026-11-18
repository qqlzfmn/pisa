# 019 · 实施方案

## 入口与去重

复用 `GithubWatcher` 的轮询循环：评论链路之后再跑一遍评审发现，两者各自 try/catch，互不影响。评审发现不依赖评论，只用 PR 列表。

去重分两层：

1. `meta` 的 `github:review:<repo>#<n>` 记录已投递的 head SHA，避免每轮重复投递和基线回填；
2. `Router` 的触发器 `(threadKey, messageKey)`——线程是 `github:<repo>:review:<n>`，消息是 head SHA。即使 meta 因崩溃没更新，同 SHA 也只会命中同一个任务。

`github:review:since:<repo>` 是启用时刻基线，只用来跳过「启用前就存在」的开放 PR；这些 PR 的 head 会写入基线 meta，后续新提交仍会被评审。

## 任务模型

`Task` 增加两个字段：

- `readonly: boolean`：只读任务标记，落库列 `readonly INTEGER NOT NULL DEFAULT 0`
- `reviewBase: string | null`：评审对比的目标分支，落库列 `review_base TEXT`

`IncomingMessage.readonly` 透传到任务。旧库启动时补列。

## 执行路径

`Router.runTask` 在创建 worktree 前处理只读任务：

1. `prepareReviewCheckout`：本地缺 head SHA 时 fetch `origin pull/<n>/head` 并校验；缺 `origin/<base>` 时 fetch 目标分支
2. 按 head SHA 建 `pisa/<id>` 临时分支与工作副本
3. Worker 完成后不进入 `GitDeliverer`：直接 `transition(succeeded)`，删除工作副本与临时分支，用 `formatReviewReply` 回帖并同步 chat 回执

失败/取消沿用既有清理逻辑。同一 SHA 不会再次投递，所以失败不自动重试是明确语义。

## 只读约束

- `OmpAdapter.buildEnv` 在 `task.readonly` 时注入 `PISA_READONLY=1`
- `buildPrompt` 用「## 只读评审」段落替代交付约束
- `extensions/pisa-worker.ts` 只读模式下拒绝写入类工具名（write/edit/patch 等）
- `guard.blockBash` 增加只读参数，拒绝 git 写子命令；读命令（diff/log/show/status）放行

## 回帖

`replyToSource` 按 `task.readonly` 选择头部：`formatReply` → `**pisa** 任务完成`，`formatReviewReply` → `**pisa** 评审结论`。隐藏标记、outbox 重试、按仓库回帖都不变。

## 影响面

- `github.ts` 新增 PR 列表与评审文案
- `github-watcher.ts` 新增 `pollReviews`
- `types.ts` / `store.ts` 新增列与字段
- `router.ts` 只读任务分支
- `git.ts` 评审检出准备
- `adapters/omp.ts` / `extensions/*` 只读约束
- 文档：`docs/operations.md` 配置与行为，`docs/architecture.md` 任务列说明
