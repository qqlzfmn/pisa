# 014 · Worker 边界 guard

- 状态：implemented
- 关联：003（Worker 扩展与策略拦截）
- 依赖：无

## 1. 问题

Worker 的边界有两套说法：提示词（`src/adapters/omp.ts`）写「不要访问父目录 / 不要 checkout 主分支 / 不要 push」，代码（`extensions/pisa-worker.ts`）只有 6 条以行首 `git` 为锚的正则。两者不一致，且代码侧有可直接利用的缺口：

- `git -c user.name=x push origin main`：全局选项插在子命令之前，行首正则不匹配
- `git -C <主仓库> push`：同上，还能把仓库指到 workdir 之外
- `git checkout main`、`git worktree remove`、`git branch -D`、`git rebase`、`git commit --amend`：没有规则
- `write` / `edit` 等文件工具的 `path` 完全没有校验：可以写 `.pisa/logs/` 下其它任务的日志、改主工作区未提交改动、改 `.pisa/pisa.db`

读提示词的人会以为边界存在，实际不存在。这是 SSOT 违反，也是安全缺口。

## 2. 目标

- 「被拦截」由代码决定，提示词只陈述事实
- bash：先剥离 git 全局选项再判子命令，覆盖已知绕过
- 文件工具：任何路径型参数解析后必须落在 workdir 内
- 判定逻辑是纯函数，可单测，不依赖 omp 运行时

## 3. 用户故事

### US-1 全局选项不能绕过 push 拦截

作为 pisa 的维护者，Worker 执行 `git -c user.name=x push origin main` 时命令被拒绝并上报 `blocked` 事件。

### US-2 不能把仓库指到工作副本之外

作为 pisa 的维护者，Worker 执行 `git -C <主仓库> push` 或 `git --work-tree=<主仓库> status` 时被拒绝。

### US-3 不能切换分支或改动主分支历史

作为 pisa 的维护者，Worker 执行 `git checkout main`、`git switch main`、`git rebase main`、`git commit --amend`、`git worktree remove`、`git branch -D` 时被拒绝。

### US-4 文件工具不能越界

作为 pisa 的维护者，Worker 的 `write` / `edit` / `read` 带 `path` 指向 workdir 之外时被拒绝并上报 `blocked`。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `extensions/guard.ts`，导出纯函数 `blockBash(cmd, workdir)` 与 `outsideWorkdir(p, workdir)`，返回值是中文拒绝原因或 `null`；`pisa-worker.ts` 只做事件接线 |
| FR-002 | bash 判定按 shell 分隔符（`;` `&` `\|` 换行、括号、反引号）切段，每段独立判定；引号内的字符串作为命令再判一次，防 `bash -c "git push"` |
| FR-003 | git 段先剥离全局选项（`-c`、`-C`、`--no-pager`、`--paginate`、`--git-dir`、`--work-tree` 等）再取子命令；`push` 任意形态、`rebase`、`reset --hard`、`clean -f`/`--force`、`worktree remove/prune`、`branch -D/-d`、`commit --amend`、`checkout`/`switch` 到任何 ref 一律拒绝；`checkout -- <path>` 只恢复文件，放行 |
| FR-004 | `-C` / `--work-tree` / `--git-dir` 的取值解析为绝对路径后必须落在 workdir 内，否则拒绝 |
| FR-005 | 保留原有破坏性命令拦截：`sudo`、`rm -rf /`（`/tmp` 除外）、`chmod`/`chown` 作用于 `/etc` |
| FR-006 | 文件工具：`path` / `file_path` / `filePath` / `target` 解析为绝对路径后必须落在 workdir 内，否则 block 并 emit `type=blocked` |
| FR-007 | workdir 为空时无法判定边界，路径与 `-C` 类判定一律拒绝并说明原因 |
| FR-008 | 提示词改为陈述「这些约束由 guard 强制」，删除与实现不一致的句子 |
| FR-009 | `tests/guard.test.ts` 直接 import `guard.ts`，覆盖全部已知绕过与放行样本 |

## 5. 验收

1. `git push`、`git -c user.name=x push origin main`、`git -C <workdir 外> push`、`git --no-pager push` 均返回拒绝原因
2. `git checkout main`、`git switch main`、`git worktree remove x`、`git branch -D x`、`git rebase main`、`git commit --amend`、`git reset --hard`、`git clean -fd` 均拒绝
3. `git status`、`git diff`、`git log`、`git commit -m x`、`git checkout -- src/a.ts`、`git worktree list` 放行
4. `outsideWorkdir("/w/a.ts", "/w")` 为 `null`；`outsideWorkdir("/w/../x", "/w")`、`outsideWorkdir("/etc/passwd", "/w")` 返回原因
5. `tests/guard.test.ts` 至少 12 条样本，`bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 读取仓库状态（当前分支、远端地址）：guard 是纯函数，不执行 git，因此拦截所有分支切换而不区分当前分支
- 完整的 shell 语法解析：只切分隔符与引号，不做 AST
- 网络、进程、环境变量的沙箱
- 经第三方程序间接执行（`xargs git push`、`find -exec git push`）、git alias 指向 push、`bash -c'…'` 这类引号与 `-c` 紧贴的写法：guard 只按分隔符与引号切词，不复原 shell 与 alias 语义
