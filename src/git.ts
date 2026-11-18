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

export function commitAll(workdir: string, message: string, name: string, email: string): ExecResult {
  const add = sh(["git", "-C", workdir, "add", "-A"]);
  if (add.code !== 0) return add;
  return sh(["git", "-C", workdir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", message]);
}

export function remoteUrl(workdir: string): string {
  return sh(["git", "-C", workdir, "remote", "get-url", "origin"]).out;
}

export function pushBranch(workdir: string, branch: string): ExecResult {
  return sh(["git", "-C", workdir, "push", "-u", "origin", branch]);
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

export interface CreatePrOptions {
  title: string;
  body: string;
  base: string;
  head: string;
}

export function createPr(workdir: string, opts: CreatePrOptions): ExecResult {
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
