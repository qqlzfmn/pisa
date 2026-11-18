export interface ExecResult {
  code: number;
  out: string;
  err: string;
}

/** `sh` 的返回值：额外标出是否由超时杀掉了进程 */
export interface ShResult extends ExecResult {
  timedOut: boolean;
}

export interface ShOptions {
  /** 替换整个子进程环境；缺省继承 pisa 进程环境 */
  env?: Record<string, string>;
  /** 超时毫秒数；到点用 SIGKILL 杀掉进程 */
  timeoutMs?: number;
}

export function sh(args: string[], cwd?: string, opts: ShOptions = {}): ShResult {
  const p = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const }),
  });
  // 只有显式传了超时才可能由我们的 SIGKILL 结束；Bun 到点时返回 exitCode=null
  const timedOut =
    opts.timeoutMs !== undefined && p.exitCode === null && p.signalCode === "SIGKILL";
  return {
    code: p.exitCode ?? -1,
    out: (p.stdout?.toString() ?? "").trim(),
    err: (p.stderr?.toString() ?? "").trim(),
    timedOut,
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

/**
 * 敏感路径：凭据、私钥与 CI 工作流。命中即不进入交付提交，
 * 避免回执泄露文件名，也避免 push 后 CI 用仓库凭据执行 agent 写入的工作流。
 */
export function isSensitivePath(path: string): boolean {
  const p = path.toLowerCase();
  if (/(^|\/)\.github\/(workflows|actions)\//.test(p)) return true;
  const name = p.slice(p.lastIndexOf("/") + 1);
  return (
    name.startsWith(".env") ||
    name.startsWith("secrets") ||
    name.startsWith("id_") ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    name === ".npmrc" ||
    name === ".netrc"
  );
}

/** 索引里的全部路径：`git add -A` 之后按文件展开，未跟踪目录不会折叠成一条 */
function stagedFiles(workdir: string): string[] | null {
  const p = Bun.spawnSync(["git", "-C", workdir, "diff", "--cached", "--name-only", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((p.exitCode ?? -1) !== 0) return null;
  return (p.stdout?.toString() ?? "").split("\0").filter(Boolean);
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

export interface CommitResult extends ExecResult {
  /** 实际进入本次提交的路径 */
  files: string[];
  /** 命中敏感路径、已用 `git reset` 剔出索引的路径 */
  blocked: string[];
}

/** `git add -A` 后剔除敏感路径再提交；全被拦下时不产生空提交 */
export function commitAll(workdir: string, message: string, name: string, email: string): CommitResult {
  const add = sh(["git", "-C", workdir, "add", "-A"]);
  if (add.code !== 0) return { ...add, files: [], blocked: [] };

  const staged = stagedFiles(workdir);
  if (!staged) return { code: -1, out: "", err: "读取索引失败", files: [], blocked: [] };
  const blocked = staged.filter(isSensitivePath);
  if (blocked.length > 0) {
    // 按 pathspec 分拣而不是信任 .gitignore：agent 可以改 .gitignore 把敏感文件放进索引
    const reset = sh(["git", "-C", workdir, "reset", "-q", "--", ...blocked.map((path) => `:(literal)${path}`)]);
    if (reset.code !== 0) return { ...reset, files: [], blocked };
  }
  const files = staged.filter((path) => !isSensitivePath(path));
  // 全被拦下时不产生空提交
  if (files.length === 0) return { code: 0, out: "", err: "", files, blocked };

  const commit = sh([
    "git",
    "-C",
    workdir,
    "-c",
    `user.name=${name}`,
    "-c",
    `user.email=${email}`,
    "commit",
    "-m",
    message,
  ]);
  return { ...commit, files, blocked };
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

/** 本地分支名（refs/heads/*）：对账用来找任务记录之外的分支 */
export function localBranches(repoPath: string): string[] {
  const res = sh(["git", "-C", repoPath, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (res.code !== 0) return [];
  return res.out.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** 远端跟踪分支名（refs/remotes/<remote>/*，去掉 remote 前缀与 HEAD）：只看本地引用，不联网 */
export function remoteBranches(repoPath: string, remote = "origin"): string[] {
  const res = sh(["git", "-C", repoPath, "for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}`]);
  if (res.code !== 0) return [];
  return res.out
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name.startsWith(`${remote}/`))
    .filter((name) => !name.endsWith("/HEAD"))
    .map((name) => name.slice(remote.length + 1));
}

export interface WorktreeInfo {
  path: string;
  /** 工作副本检出的分支；detached HEAD 时为 null */
  branch: string | null;
}

/** git 登记的工作副本；porcelain 里每块以 `worktree <path>` 开头，后跟可选的 `branch refs/heads/<name>` */
export function listWorktrees(repoPath: string): WorktreeInfo[] {
  const res = sh(["git", "-C", repoPath, "worktree", "list", "--porcelain"]);
  if (res.code !== 0) return [];
  const out: WorktreeInfo[] = [];
  let current: WorktreeInfo | null = null;
  for (const line of res.out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) out.push(current);
      current = { path: line.slice("worktree ".length).trim().replace(/^"|"$/g, ""), branch: null };
      continue;
    }
    if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  if (current) out.push(current);
  return out;
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
