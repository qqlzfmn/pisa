# 017 · 实施计划

## 1. 结构

- `src/auto-merge.ts`：纯编排。`snapshotPr` 读状态 → `waitForCi` 轮询 → `gh pr diff` → 注入的 `review` 回调 → `parseVerdict` → 复查 head → `gh pr merge`。所有外部命令走注入的 `Runner`，测试不需要网络。
- `src/router.ts`：接线。`runTask` 成功后按开关启动后台合并；`/pisa merge` 在开关打开时委托同一函数；评审实现在 Router 里，因为它需要 `WorkerRunner`、仓库路径与 `AGENTS.md`。
- `src/config.ts`：`GithubConfig.autoMerge?: boolean`，缺省 `false`。

## 2. 关键取舍

| 决策 | 备选 | 理由 |
| --- | --- | --- |
| 任务成功后自动启动合并 | 只在 `/pisa merge` 时走 PR 流程 | Issue 的验收要求「任务产出 PR、等 CI、评审、合并」是一条自动链路；手动触发等于把 CI 门禁留在人手边 |
| 合并只动远端 | 先 `git fetch` 再本地 squash | `gh pr merge --squash --delete-branch` 是 GitHub Flow 的标准动作，避免本地主干与服务重启；失败也不会留下半合并的主干 |
| 评审 worker 不写入、只看 diff | 让评审者读完整工作副本并跑测试 | 跑测试会与 CI 重复且拖长链路；`--detach` 工作副本仍允许它按需读文件，但提示词禁止写入 |
| 解析失败按未通过 | 重试评审 N 次 | 无法确认 verdict 时合并是不可逆错误；fail-closed，人工看日志重试更安全 |
| head 变化直接放弃 | 重新评审新 head | 重新评审会让等待时间翻倍；放弃并回报，下一轮由人决定 |
| `merge` 副作用只记 `{base}` | 记 `{from,to}` 让 rewind 用 `git revert` | squash 提交不在任务分支上，`from..to` 无法覆盖；`rewind` 走 `prStatus.mergeCommit` 的单提交 revert 分支 |
| 自动合并不占并发名额 | 复用 `active` 计数 | 评审 worker 会与任务 worker 抢 CPU，但合并阶段主要是等待；占名额会让后面的任务白等评审 |

## 3. 数据流

```text
runTask 成功 → delivery.prUrl
  → autoMerge(task)
      pr view (state,headRefOid,statusCheckRollup)  ← 轮询到绿/失败/超时
      gh pr diff
      review = runReview: git worktree add --detach <state>/review/<id> <head>
                          Worker.run(新会话, 提示词=diff+规范)
      parseVerdict
      pr view 复查 head
      gh pr merge --squash --delete-branch
      pr view (state,mergeCommit) → mergeCommit
  → store.effect("merge", base, {"base"}) → 清理本地分支/工作副本 → 回执
```

## 4. 风险

- **CI 检查为空**：仓库没配 Actions 时不合并，属于预期行为；回执写明「没有任何 CI 检查」。
- **`gh pr merge` 失败**（保护分支、需要 review）：阻塞并回报 `gh` 的错误，不重试。
- **进程重启丢失进行中的合并**：`autoMerging` 是内存态；重启后人工 `/pisa merge` 会从头重跑整条流水线（幂等：PR 已合并时直接回报）。
- **评审输出过长**：`Worker.run` 的 summary 截断到 4000 字；提示词要求只输出 JSON，解析器容忍围栏与解释文字。

## 5. 验证

- `tests/auto-merge.test.ts`：`ciVerdict`、`parseVerdict`、四条阻塞路径 + 通过路径；Router 开关关闭与无 PR 两条接线用例
- `bun test`、`bunx tsc --noEmit`
- 真实链路（建 PR、等 CI、评审、合并）需要 GitHub 远程与 token，本机未实跑，已在 README 已知限制注明
