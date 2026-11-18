# 020 · 任务清单

- [x] T001 `src/config.ts`：`github.review.enabled` 开关，缺省关闭（FR-001）
- [x] T002 `src/types.ts`、`src/store.ts`：`TaskMode`、`tasks.mode` 列与迁移、读写映射（FR-003）
- [x] T003 `src/github.ts`：`listOpenPrs` 返回 `headSha/title/baseRefName/url`；新增 `prDiff`（FR-002/FR-007）
- [x] T004 `src/pr-review.ts`：评审线程键、事件键、提示词与 diff 截断（FR-003/FR-004）
- [x] T005 `src/github-watcher.ts`：`pollReviews` 按 head SHA 去重后投递 review 任务（FR-001/FR-002/FR-005/FR-006）
- [x] T006 `src/router.ts`：review 任务独立执行路径，临时目录、无 worktree、成功回帖（FR-004/FR-005）
- [x] T007 `tests/github-review.test.ts`：开关、去重、跨实例去重、新 SHA、diff 失败重试、只读回帖（FR-001–FR-007）
- [x] T008 文档：example config、operations、architecture、CHANGELOG（FR-001）
