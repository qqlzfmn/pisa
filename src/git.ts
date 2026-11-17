export interface ExecResult {
  code: number;
  out: string;
  err: string;
}

export function sh(args: string[], cwd?: string): ExecResult {
  const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: p.exitCode ?? -1,
    out: (p.stdout?.toString() ?? "").trim(),
    err: (p.stderr?.toString() ?? "").trim(),
  };
}

export function isGitRepo(path: string): boolean {
  return sh(["git", "-C", path, "rev-parse", "--git-dir"]).code === 0;
}

export function currentBranch(path: string): string {
  return sh(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"]).out;
}

export function createWorktree(repoPath: string, workdir: string, branch: string, base = "HEAD"): ExecResult {
  const add = sh(["git", "-C", repoPath, "worktree", "add", "-b", branch, workdir, base]);
  if (add.code === 0) return add;
  // 分支已存在（重跑/恢复）：直接挂载
  return sh(["git", "-C", repoPath, "worktree", "add", workdir, branch]);
}

export function removeWorktree(repoPath: string, workdir: string): void {
  sh(["git", "-C", repoPath, "worktree", "remove", "--force", workdir]);
  sh(["git", "-C", repoPath, "worktree", "prune"]);
}

/** 清理失败/取消任务留下的空分支 */
export function deleteBranch(repoPath: string, branch: string): void {
  sh(["git", "-C", repoPath, "branch", "-D", branch]);
}

export function changedFiles(workdir: string): string[] {
  // 不能用 sh()：它 trim 了行首状态位中的空格，会把 " M a.txt" 解析错
  const p = Bun.spawnSync(["git", "-C", workdir, "status", "--porcelain", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((p.exitCode ?? -1) !== 0) return [];
  const raw = p.stdout?.toString() ?? "";
  return raw
    .split("\0")
    .filter(Boolean)
    .map((rec) => rec.slice(3))
    .filter(Boolean);
}

/** `git diff --name-status -z` 的条目；改名/复制是「旧路径 + 新路径」一条记录 */
function nameStatus(workdir: string, args: string[]): { entries: string[][]; err: string } {
  // 显式 -M：diff.renames 是仓库配置，agent 能关掉；关掉后改名拆成 D+A，
  // 敏感文件改名到普通文件名就只剩新路径待判，内容会以新名字进提交
  const p = Bun.spawnSync(["git", "-C", workdir, "diff", "--name-status", "-z", "-M", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((p.exitCode ?? -1) !== 0) {
    return { entries: [], err: (p.stderr?.toString() ?? "").trim() || "git diff 失败" };
  }
  const parts = (p.stdout?.toString() ?? "").split("\0");
  const entries: string[][] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]!;
    const paths = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    entries.push(parts.slice(i, i + paths));
    i += paths;
  }
  return { entries, err: "" };
}

/** 分支相对 base 的全部改动：agent 自己提交的记录也在里面，推送前用它核对 */
export function branchEntries(workdir: string, base: string): { entries: string[][]; err: string } {
  return nameStatus(workdir, [`${base}...HEAD`]);
}

/** 全量暂存后按路径分拣：isBlocked 命中的条目从索引移除，不进入本次提交 */
export function stageAllExcept(
  workdir: string,
  isBlocked: (path: string) => boolean,
): { files: string[]; blocked: string[]; err: string } {
  const add = sh(["git", "-C", workdir, "add", "-A"]);
  if (add.code !== 0) return { files: [], blocked: [], err: add.err || add.out };

  const { entries, err } = nameStatus(workdir, ["--cached"]);
  if (err) return { files: [], blocked: [], err };
  const kept = entries.filter((paths) => !paths.some(isBlocked));
  const blocked = entries.filter((paths) => paths.some(isBlocked)).flat();
  if (blocked.length > 0) {
    // :(literal) 避免文件名里的 * ? [ 被当成 pathspec 通配
    const reset = sh(["git", "-C", workdir, "reset", "-q", "--", ...blocked.map((path) => `:(literal)${path}`)]);
    if (reset.code !== 0) return { files: [], blocked, err: reset.err || reset.out };
  }
  return { files: kept.flat(), blocked, err: "" };
}

/** hooks 在共享 .git 里，agent 能装 pre-commit 把敏感文件补回索引：提交与推送都不执行 hook */
export function commitStaged(workdir: string, message: string, name: string, email: string): ExecResult {
  return sh(["git", "-C", workdir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--no-verify", "-m", message]);
}

export function remoteUrl(workdir: string): string {
  return sh(["git", "-C", workdir, "remote", "get-url", "origin"]).out;
}

export function pushBranch(workdir: string, branch: string): ExecResult {
  return sh(["git", "-C", workdir, "push", "--no-verify", "-u", "origin", branch]);
}

/** 无 PR 能力时给一个可点的对比链接 */
export function compareUrl(remote: string, base: string, branch: string): string | null {
  if (!remote) return null;
  const ssh = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  const https = remote.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  const host = ssh?.[1] ?? https?.[1];
  const path = (ssh?.[2] ?? https?.[2] ?? "").replace(/\.git$/, "");
  if (!host || !path) return null;
  if (host.includes("github.com")) return `https://${host}/${path}/compare/${base}...${branch}?expand=1`;
  if (host.includes("cnb.cool")) return `https://${host}/${path}/-/compare/${base}...${branch}`;
  return `https://${host}/${path}/compare/${base}...${branch}`;
}

export function hasGh(): boolean {
  return sh(["gh", "--version"]).code === 0;
}

export function createPr(
  workdir: string,
  opts: { title: string; body: string; base: string; head: string },
): ExecResult {
  return sh([
    "gh",
    "pr",
    "create",
    "--title",
    opts.title,
    "--body",
    opts.body,
    "--base",
    opts.base,
    "--head",
    opts.head,
  ], workdir);
}
