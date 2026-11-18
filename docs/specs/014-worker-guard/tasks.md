# 014 · 任务

- [x] `extensions/guard.ts`：`outsideWorkdir`、tokenizer（分隔符 + 引号）、git 全局选项剥离与子命令规则、破坏性命令规则
- [x] `extensions/pisa-worker.ts`：只做事件接线，bash 走 `blockBash`，文件工具走 `outsideWorkdir`，越界 emit `type=blocked`
- [x] `src/adapters/omp.ts`：约束段改为「由 guard 强制」，删除与实现不一致的祈使句
- [x] `tsconfig.json`：`include` 加入 `extensions`，让 `guard.ts` 与扩展接线参与类型检查
- [x] `tests/guard.test.ts`：19 组样本，覆盖 `git -c ... push`、`git -C <外> push`、`checkout main`、`worktree remove`、`branch -D`、`rebase`、`commit --amend`、`reset --hard`、`clean -f`、`sudo`、`rm -rf /`、workdir 内外路径
- [x] `docs/specs/003-super-agent-loop/spec.md`：策略清单改为指向 014
- [x] 验证：`bun test`（147 pass）、`bunx tsc --noEmit`（无错误）、omp 实际加载扩展并写出 `session` 事件
