# 014 · 交付前敏感路径拦截

- 状态：implemented
- 关联：001（交付链路 T5）、013（账本）
- 依赖：git

## 1. 问题

交付走 `changedFiles` + `git add -A`，对路径零筛选。实测 worktree 里写入 `.env` 与 `.github/workflows/ci.yml` 后，两者都进入提交，`.env` 还出现在回执的文件清单里；`delivery.push` 打开时直接进远端分支。

放大风险：

- `.github/workflows/**` 推送后由仓库凭据在 CI 里运行，等于把「评论派活」升级成远端代码执行
- 分拣靠 `.gitignore` 不可靠：agent 自己就能改 `.gitignore` 放行敏感文件
- 交付链路自身也可被 agent 摆布：它能自己 `git commit` 把敏感文件写进分支历史（推送时一起上线），也能往共享 `.git` 里装 pre-commit hook 在提交时把敏感文件补回索引

## 2. 目标

- 提交前按路径分拣，命中的文件不进入本次提交、不进入推送
- 拦截结果写进 `DeliveryResult` 与回执，任务仍按成功处理（不静默吞掉）
- 全部改动都被拦时不产生空提交、不推送

## 3. 用户故事

### US-1 看见被拦下的东西

作为任务发起者，回执里能看到「⚠️ 未提交的敏感路径：.env」，知道这次交付少了什么，自己决定是否手工处理。

### US-2 CI 不被顺手改掉

作为仓库维护者，agent 改动 `.github/workflows/**` 不会随任务分支推送，流水线保持原样。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `isSensitivePath` 命中：`.github/workflows/**`、`.github/actions/**`（仓库根）、任意深度的 `.env*`、`*.pem`、`*.key`、`id_*`、`.npmrc`、`.netrc`、`secrets*` |
| FR-002 | 交付先 `git add -A`，读出索引条目后对命中项 `git reset -- <path>`，其余进入提交 |
| FR-003 | 索引条目按「改名/复制为一条」处理：任一端命中则整条不提交，避免只提交新增路径留下副本；读索引时显式带 `-M`，不依赖仓库配置 `diff.renames`（agent 能关掉，关掉后敏感文件改名到普通文件名只剩新路径待判，内容会以新名字进提交） |
| FR-004 | `DeliveryResult.blocked: string[]` 记录被拦路径；`files` 只含真正进入提交的文件 |
| FR-005 | 回执追加 `⚠️ 未提交的敏感路径：…`（最多列 8 条，超出标注总数），任务状态仍为 `succeeded` |
| FR-006 | 全部改动被拦时返回 `files: []`、`pushed: false`，不产生空提交；既有 `prUrl` 绑定照旧保留 |
| FR-007 | 分拣只看路径，不读 `.gitignore`；agent 改 `.gitignore` 放行不能绕过 |
| FR-008 | 提交与推送都不执行工作树 hooks（`--no-verify`）：hook 装在共享 `.git` 里，agent 能借它往索引里补文件 |
| FR-009 | 推送前按同一规则核对 `base...HEAD` 的整条分支（同样显式 `-M`）：命中则不推送并抛错（任务按失败处理），agent 自己 `git commit` 的记录因此上不了远端 |

## 5. 验收

1. worktree 同时改动 `a.txt`、`.env`、`.github/workflows/ci.yml` → `git show --name-only` 只含 `a.txt`，`blocked` 长度 2，推送语义不变
2. 回执出现「⚠️ 未提交的敏感路径」，任务状态 `succeeded`
3. 全部改动都被拦 → `files: []`、`pushed: false`、HEAD 不变、远端无该分支
4. `.gitignore` 写入 `!.env` 后 `.env` 仍被拦
5. agent 自己 `git commit` 提交 `.env` 后再有正常改动 → 交付抛「分支历史含敏感路径」，远端无该分支；worktree 的 `pre-commit` hook 往索引里补 `.env` → 提交只含普通文件
6. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 内容级检测（凭据特征、熵）：只看路径，`cp .env notes.txt` 这类改写拦不住
- 改名且内容大改到相似度低于 `-M` 阈值时 git 仍拆成 D+A：旧路径的删除被拦，改写后的新路径因路径普通而放行
- 覆盖广度优先于误报：`id_*`、`secrets*`、`.env*` 会误伤 `id_utils.ts`、`secrets.ts` 这类正常文件；误报在回执里可见，可人工处理
- 已存在的敏感文件从历史里清除
- agent 直接改写 refs（如把 base 分支指到含敏感路径的提交）或自己执行 `git push`（远端凭据就在仓库里）：拦截只覆盖交付链路自己的提交与推送
