# 019 · 任务清单

- [x] T001 `src/config.ts`：`GithubReviewConfig` 与 `github.review`
- [x] T002 `src/github.ts`：`listOpenPrs`、`formatReviewReply`、`reviewRequest`
- [x] T003 `src/types.ts` / `src/store.ts`：`readonly` 与 `reviewBase` 字段、建表、迁移、读写映射
- [x] T004 `src/github-watcher.ts`：评审基线、按 PR 去重、投递评审任务
- [x] T005 `src/git.ts` / `src/router.ts`：评审检出准备、只读任务执行与回帖
- [x] T006 `src/adapters/omp.ts` / `extensions/guard.ts` / `extensions/pisa-worker.ts`：只读提示与工具拦截
- [x] T007 测试：开关、去重、新 SHA、基线回填、只读执行不回帖交付、guard
- [x] T008 文档：`docs/operations.md`、`docs/architecture.md`
