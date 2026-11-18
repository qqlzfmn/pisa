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

export interface TimedExecResult extends ExecResult {
  /** 进程因超时被杀，code 不可当作正常退出码 */
  timedOut: boolean;
}

/**
 * 有墙钟上限的异步执行，用于跑不受信任的代码（验证副本里的测试）。
 * 不能用 sh()：spawnSync 会阻塞事件循环，且没有超时。
 * 子进程独立成组，超时按组 SIGKILL，连同它在测试里拉起的子进程一起收掉。
 */
export async function shTimed(
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<TimedExecResult> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, opts.timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, out: out.trim(), err: err.trim(), timedOut };
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

/** 分支是否已推到 origin：只看本地远端跟踪引用，不联网 */
export function pushedBranch(workdir: string, branch: string): boolean {
  return sh(["git", "-C", workdir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).code === 0;
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

/** 分支上已有的开放 PR：远端状态即幂等键，崩溃重试时认领而不是再造一个 */
export function findPr(workdir: string, branch: string): ExecResult {
  return sh(["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url"], workdir);
}
