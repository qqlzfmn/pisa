# 014 · 计划

## 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 存储 | `src/store.ts` | `effects` 表与 `enqueueEffect` / `effectJob` / `pendingEffects` / `deferEffect` / `settleEffect` |
| 队列 | `src/effects.ts` | `EffectQueue`：入队即落库、进程内去重、退避重试、`replay` / `stop` |
| 执行 | `src/deliver.ts`、`src/router.ts` | `push` / `pr` 由交付器执行，`comment` 由 router 执行 |
| 接入 | `src/router.ts`、`src/index.ts` | 交付与回帖改为入队；启动时 `replayEffects()` |

## 关键决策

1. **两份账本分工**：`task_effects` 记「任务留下了哪些可逆副作用」（rewind 用），`effects` 记「哪个外部动作做过没有」（幂等与重试用）。前者是业务视图，后者是动作日志，不合并。
2. **去重键带内容**：`push` 的键含 `HEAD` 提交号，续跑产生新提交仍会推；`pr` 的键只含分支，同分支永远只开一个 PR；`comment` 的键含任务号，同一任务对同一讨论串只回一次。
3. **动作在主仓库执行**：`push` / `pr` 用 `repo.path` 而不是会被清理的 worktree，崩溃重启后 worktree 不在了也能重放；分支引用在共享 `.git` 里。
4. **阻塞式入队**：`enqueue` 返回最终结果（成功结果或耗尽后的错误），调用方据此决定日志与任务状态；重试期间任务不提前收尾。
5. **退避可注入**：`EffectQueueOptions.sleep/now/maxAttempts` 给测试注入假时钟，生产用真实定时器。

## 验证

- `tests/effects.test.ts`：去重、已完成复用、退避阶梯、重启重放、关停保留
- `tests/github-comments.test.ts`：交付器用例改为经真实 `EffectQueue` 执行；`gh` 失败用例注入零等待，断言任务仍成功
- `bun test`、`bunx tsc --noEmit`
