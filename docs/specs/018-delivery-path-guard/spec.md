# 018 · 交付提交拦截敏感路径

- 状态：implemented
- 关联：001（交付链路）、015（CI 工作流）
- 依赖：无

## 1. 问题

`GitDeliverer.deliver` 调 `commitAll`（`src/git.ts`），内部是 `git add -A`，对路径零筛选。工作副本里写出的 `.env`、`.github/workflows/*.yml` 会进入提交，出现在回执的文件清单里；`delivery.push` 打开后直接进远端分支。工作流文件 push 后会在 CI 里用仓库凭据自动运行，等于把「评论派活」升级成「远端代码执行」。agent 也能改 `.gitignore` 让敏感文件进入索引，所以按 pathspec 分拣比信任 `.gitignore` 可靠。

复现（改动前）：工作副本同时改动 `a.txt`，新增 `.env` 与 `.github/workflows/ci.yml`，`commitAll` 后 `git show --name-only HEAD` 输出三个文件，`.env` 在回执中可见。

## 2. 目标

- 敏感路径不进入交付提交，因此也不进入推送与 PR
- 拦截结果不静默吞掉：回执列出未提交的路径，任务仍按成功处理
- 全部改动都被拦下时不产生空提交
- 判定只看路径，不依赖 `.gitignore` 或文件内容

## 3. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `src/git.ts` 导出 `isSensitivePath(path)`：命中 `.github/workflows/**`、`.github/actions/**`、`.env*`、`*.pem`、`*.key`、`id_*`、`.npmrc`、`.netrc`、`**/secrets*` |
| FR-002 | `commitAll` 在 `git add -A` 后用 `git diff --cached --name-only -z` 展开索引，命中的路径先 `git reset -- <path>`，再提交剩余文件 |
| FR-003 | `commitAll` 返回 `CommitResult`：原 `ExecResult` 字段外加 `files`（已提交）与 `blocked`（被拦下）；全被拦下时返回 `code: 0` 且不执行 commit |
| FR-004 | `DeliveryResult` 增加 `blocked: string[]`；回执在文件清单后追加「⚠️ 未提交的敏感路径：…」 |
| FR-005 | 交付的 `files` 只含实际提交的文件；全被拦下时 `files: []`、`pushed: false`，任务仍 `succeeded` |
| FR-006 | 推送与 PR 逻辑不变；`blocked` 不参与 `pushed` / `prUrl` 的判定，全部被拦下时因无可提交文件自然不推送 |

## 4. 验收

1. 工作副本同时改动 `a.txt`，新增 `.env` 与 `.github/workflows/ci.yml`：`git show --name-only` 只含 `a.txt`，`blocked` 长度 2，`pushed` 语义不变
2. 只改动敏感文件：不产生新提交，`files: []`、`pushed: false`
3. 推送打开时远端分支同样只含 `a.txt`
4. 回执含「⚠️ 未提交的敏感路径：.env, .github/workflows/ci.yml」
5. `tests/deliver.test.ts` 覆盖分类器、混合改动、全拦截、推送、回执
6. `bun test` 与 `bunx tsc --noEmit` 通过

## 5. 非目标

- 扫描 agent 在交付前自行执行的 `git commit` / `git push`（命令拦截属 014-worker-guard）
- 按文件内容识别密钥
- 删除工作副本里的敏感文件；只把它们留在未跟踪/未暂存状态
