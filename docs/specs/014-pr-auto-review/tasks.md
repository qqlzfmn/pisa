# 014 · 任务

- [x] `src/types.ts`：`TaskMode`、`Task.mode`、`IncomingMessage.reviewPr` / `ReviewTarget`
- [x] `src/store.ts`：`tasks.mode` 列与迁移、`claimQueued` 接受空分支
- [x] `src/config.ts`：`github.review.enabled`、`github.repos[].alias`
- [x] `src/github.ts`：`listOpenPulls`、`PullSummary`、`reviewPrompt`、`formatReview`
- [x] `src/git.ts`：`createReviewWorktree`（拉 `refs/pull/<n>/head`、分离 HEAD 检出）
- [x] `src/github-watcher.ts`：开关判断、草稿跳过、`repo#pr@sha` 去重、投递评审事件
- [x] `src/router.ts`：`enqueueReview` / `createTask`、评审任务的启动、执行与回帖分支
- [x] `src/adapters/omp.ts`：评审提示词约束、`PISA_READONLY`
- [x] `extensions/pisa-worker.ts`：只读模式拦截写文件与 git 提交类命令
- [x] `src/index.ts`：启用评审时的启动日志
- [x] `tests/pr-review.test.ts`：列表解析、提示词与回帖格式、同提交只投一次、换提交重投、开关关闭、草稿跳过、别名落库、拉取失败隔离、端到端只读执行
- [x] `tests/adapter.test.ts`：评审提示词不含写代码约束、环境带 `PISA_READONLY`
- [x] `README.md` / `pisa.config.example.json`：开关、别名、只读与去重说明
- [x] 验证：`bun test`、`bunx tsc --noEmit`
