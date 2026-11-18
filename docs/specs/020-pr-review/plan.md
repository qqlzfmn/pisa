# 020 · 实施计划

## 1. 结构

```
src/pr-review.ts        评审线程键、事件键、提示词构造（纯函数）
src/github.ts           listOpenPrs 增加 head SHA；新增 prDiff
src/github-watcher.ts   pollReviews：列 open PR → 去重 → 拉 diff → 投递
src/types.ts            TaskMode 与 Task.mode、IncomingMessage.mode
src/store.ts            tasks.mode 列 + 旧库迁移 + 读写映射
src/router.ts           review 任务走独立执行路径：临时目录、无 worktree、回帖
```

评审任务的生命周期和普通任务一致（queued → running → succeeded/failed/cancelled），差异只在执行路径：不建分支、不做交付。

## 2. 关键取舍

| 决策 | 备选 | 理由 |
| --- | --- | --- |
| 只评 diff，不检出仓库 | 建 worktree 检出 PR 分支 | 检出需要拿 PR 远端引用、处理 fork、清理工作树；评审不需要跑代码，diff 足够，且天然满足只读 |
| 去重键 `(github:<repo>:pull:<n>:review, head SHA)` 走 triggers 表 | 内存 Set 或 events 表 | triggers 表已有 `(thread_key, message_key)` 主键并跨重启保留；`messageKey=version=head SHA` 正好表达「同一版本只处理一次」 |
| 提示词与 diff 拼进任务正文 | 任务只存 URL，执行时再拉 | Worker 在无检出的临时目录里没有仓库上下文，执行时再拉会重复鉴权与失败面；创建时拉取失败就不建任务 |
| diff 超过 60000 字符截断 | 全文入库 | 任务正文进 SQLite、进 Worker 上下文；截断后明确标注，评审范围可解释 |
| 评审任务不写 `effect("worktree")` | 复用普通任务清理逻辑 | review 目录是临时目录，不是 git worktree；写进 effects 会让回滚与清理误判 |
| 评审临时目录用 `mkdtemp` | `stateDir/reviews/<id>` | 进程崩溃后系统临时目录可回收，不污染状态目录；任务失败也不需要清理记录 |
| 关闭开关只影响 PR 轮询 | 关闭整个 GitHub 入口 | 评论派活与自动评审是两个能力，开关互不影响 |

## 3. 配置

```jsonc
"github": {
  "enabled": true,
  "repos": [{ "repo": "owner/pisa", "chatId": "...", "userId": "..." }],
  "review": { "enabled": true }
}
```

`review.enabled` 缺省 `false`。评审任务沿用 `repos[]` 的 `chatId` / `userId`，进度与结论同时回到该会话。

## 4. 失败语义

- diff 拉取失败：本轮跳过，不建任务，下一轮重试。
- Worker 失败：任务置 `failed`，不回帖（避免把失败当结论）。
- 进程重启：评审任务没有 worktree，恢复逻辑按普通中断任务置 `failed`，不自动重跑；同一 head SHA 已有触发器记录，不会重复建任务。
