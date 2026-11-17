# 014 · 实施计划

## D1 纯函数模块 `extensions/guard.ts`

不依赖 omp 运行时、不读文件系统、不执行 git，只 import `node:path`。这样测试可以直接 import 而不注册扩展（`pisa-worker.ts` 的默认导出才注册事件）。

`pisa-worker.ts` 保留事件订阅与 `emit`，判定全部下沉：

```ts
if (name === "bash") {
  const reason = blockBash(cmd, WORKDIR);
  if (reason) { emit({type:"blocked", tool:name, detail:`${bashDetail(cmd)} · ${reason}`}); return {block:true, reason}; }
}
```

`blockBash` 需要 workdir 才能判 `-C` / `--work-tree` 越界，因此签名是 `blockBash(cmd, workdir)`（比需求里的 `blockBash(cmd)` 多一个参数，原因见 FR-004）。

## D2 tokenizer：分隔符 + 引号

单次扫描，维护引号状态：

- 未加引号的 ` \t\n\r;|&()` 与反引号 → 断段断词
- `\` 转义下一个字符
- 引号内字符保留（包括空格），因此 `bash -c "git push"` 产生一个含空格的 token

含空格的 token 与原始命令再判一次（深度 1），覆盖 `sh -c '...'`、`$(...)`、反引号。`$(` 中的 `(` 已在分隔符集合里，天然断开。

## D3 git 段解析

`stripGitOptions(args)` 从 `args[1]` 起扫：

- 带值选项：`-c` `-C` `--git-dir` `--work-tree` `--namespace` `--super-prefix` `--exec-path` `--config-env` `--attr-source`，支持 `--opt=value`
- 其余 `-x` 当布尔旗标跳过
- 首个非 `-` token 是子命令

`-C` / `--work-tree` / `--git-dir` 的取值交给 `outsideWorkdir`。

子命令规则表（命中即返回原因，顺序固定）：

| 子命令 | 条件 |
| --- | --- |
| `push` | 无条件 |
| `rebase` | 无条件 |
| `reset` | 参数含 `--hard` |
| `clean` | 参数含 `--force` 或 `-` 开头且含 `f`（`-f -fd -xdf`） |
| `checkout` | 除 `checkout -- <path>` 与空参数外全部拦截 |
| `switch` | 除空参数外全部拦截 |
| `worktree` | 首个参数 `remove` / `prune` |
| `branch` | 参数含 `-D` / `-d` / `--delete` |
| `commit` | 参数含 `--amend` |

`checkout` 只放行文件恢复：纯函数读不到当前分支，无法区分「切到当前分支」与「切别的分支」，一律拦截比放行安全；`checkout -- path` 不移动 HEAD，放行。

## D4 文件工具

```ts
const reasons = ["path", "file_path", "filePath", "target"]
  .map((k) => input[k])
  .filter((v) => typeof v === "string")
  .map((v) => outsideWorkdir(v, WORKDIR))
  .filter(Boolean);
```

任一越界即 block。workdir 为空返回「工作目录未知」，同样 block，避免环境变量缺失时静默放行。

## D5 提示词

`buildPrompt` 的约束段改为陈述事实：边界由 guard 强制，列出被拦的命令类别与文件范围；删除「不要 commit / 不要 checkout 主分支 / 不要强推」这类与代码不一致或无法核验的祈使句。

## 验证

- 新增 `tests/guard.test.ts`：push 四种形态、越界 `-C`、`checkout/switch`、`worktree`、`branch -D`、`rebase`、`commit --amend`、`reset --hard`、`clean -fd`、`sudo`、`rm -rf /`、`outsideWorkdir` 正反样本、放行样本
- `bun test`、`bunx tsc --noEmit`
