# 017 · PR 自动评审与合并

- 状态：implemented
- 关联：#99、`src/auto-merge.ts`、`src/router.ts`、`src/config.ts`

## 1. 问题

现有交付止步于分支：任务成功后代码停在 `pisa/<任务号>`，要人工 `/pisa merge` 才进主干。`/pisa merge` 在本机做 rebase + `--ff-only`，绕过了 PR、CI 与评审：CI 失败的分支也可能被合入，仓库没有标准的 GitHub Flow 记录。

证据：`src/router.ts` 的 `handleMerge` 只跑本地 `bun test` 与快进合并；`delivery.pr` 打开时虽会建 PR，但 PR 从不承担合并入口，合并后还要手动 `gh pr close`。复现：打开 `delivery.pr` 跑一个任务，`/pisa merge` 后 GitHub 上是「已关闭的 PR」，不是合并记录。

## 2. 目标

- 加一个开关 `github.autoMerge`（默认 `false`），打开后任务产出 PR 即自动走 GitHub Flow
- 自动合并必须同时满足：CI 全绿、独立上下文评审 pass、评审后 head SHA 未变
- 评审 fail 时把阻塞项写到 PR 评论，人改完再走下一轮
- 开关关闭时行为与现在完全一致：本地 rebase + 快进合并
- 合并只动远端 PR（squash + 删分支），不改本地主干、不重启服务

## 3. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `github.autoMerge?: boolean`，缺省 `false`；只在 `true` 时才走 PR 流程 |
| FR-002 | 任务成功后若有 `prUrl`，后台启动合并流水线；不占 `worker.concurrency` 名额 |
| FR-003 | CI 门禁：`statusCheckRollup` 全部为成功/中性/跳过才算绿；失败立即阻塞，未完成轮询到超时（默认 30 分钟） |
| FR-004 | 评审用独立 worker 会话，cwd 是 head SHA 的 `--detach` 工作副本；只给 diff、CI 结果与仓库 `AGENTS.md` |
| FR-005 | 评审输出 `{"verdict":"pass|fail","blockers":[…],"summary":"…"}`；解析失败按未通过处理，不合并 |
| FR-006 | fail 时在 PR 评论阻塞项，带隐藏标记 `<!-- pisa:review task=<id> sha=<sha> -->` |
| FR-007 | 合并前重新读一次 head；与评审时的 SHA 不同则不合并 |
| FR-008 | 通过后 `gh pr merge <n> --repo <repo> --squash --delete-branch`，记 `merge` 副作用并清理本地分支与工作副本 |
| FR-009 | `autoMerge` 开启时 `/pisa merge` 改为触发同一条 PR 流水线；任务没有 PR 时拒绝并说明缺 `delivery.pr` |
| FR-010 | 关停时等待进行中的自动合并（受 `stop(timeoutMs)` 上限约束） |
| FR-011 | `rewind` 兼容：squash 合并只记 `{base}`，回退用 PR 的 `mergeCommit` 做单提交 revert |

## 4. 非目标

- 不做审批人、required reviewers、分支保护规则配置
- 不在本地复现 CI；只读 GitHub 报告的检查结果
- 不做「评审 fail 后自动修」的回路
- 不处理同一个 PR 的多轮自动评审排队；人工 `/pisa merge` 重试即可

## 5. 验收

1. `bun test tests/auto-merge.test.ts` 覆盖开关关闭、CI 未绿、评审 fail、head 变化、全绿通过五条路径
2. 开关关闭时 `/pisa merge` 仍快进合并，且不调用评审、不调 `gh`
3. CI 未绿或评审未通过时没有任何 `gh pr merge` 调用
4. 评审 fail 的评论正文含阻塞项与 SHA 标记
5. `bun test` 与 `bunx tsc --noEmit` 通过
