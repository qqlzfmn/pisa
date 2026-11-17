import { sh, type ExecResult } from "./git";

/** 执行一条命令；测试注入假实现，不联网 */
export type Runner = (args: string[]) => ExecResult;

export const defaultRunner: Runner = (args) => sh(args);

/** 失败不抛出：调用方决定记日志还是重试 */
export type GhResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

export interface PrComment {
  id: number;
  body: string;
  /** API 给的 issue_url，形如 https://api.github.com/repos/o/r/issues/12 */
  issueUrl: string;
  userLogin: string;
}

/** 从 .../issues/<n> 或 .../pull/<n> 提取 PR 号 */
export function prNumberFromIssueUrl(url: string): number | null {
  const m = url.trim().match(/\/(?:issues|pull)\/(\d+)\/?(?:[?#].*)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** PR 所在仓库 owner/repo：只认 .../pull/<n> 链接，compare 链接返回 null */
export function prRepoFromUrl(url: string): string | null {
  const m = url.trim().match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+\/?(?:[?#].*)?$/);
  return m?.[1] ?? null;
}

export interface PrState {
  state: string;
  mergeCommit: string | null;
}

/** PR 状态与合并提交；查询失败返回 null，调用方不能据此判断已合并 */
export function prStatus(runner: Runner, repo: string, n: number): PrState | null {
  const res = runner(["gh", "pr", "view", String(n), "--repo", repo, "--json", "state,mergeCommit"]);
  if (res.code !== 0) return null;
  try {
    const raw = JSON.parse(res.out) as { state?: unknown; mergeCommit?: unknown };
    const mc = raw.mergeCommit as { oid?: unknown } | null | undefined;
    return { state: String(raw.state ?? ""), mergeCommit: typeof mc?.oid === "string" ? mc.oid : null };
  } catch {
    return null;
  }
}

export function closePr(runner: Runner, repo: string, n: number): GhResult {
  const res = runner(["gh", "pr", "close", String(n), "--repo", repo]);
  if (res.code !== 0) return { ok: false, error: res.err || res.out || `gh 退出码 ${res.code}` };
  return { ok: true, value: undefined };
}

/** 回帖正文：摘要截断到 3000 字 */
export function formatReply(summary: string): string {
  return `**pisa** 任务完成\n\n${summary.trim().slice(0, 3000)}`;
}

/** 评审回帖：标题带 PR 号与 head 短提交，方便对照评审的是哪一份代码 */
export function formatReview(pr: number, headSha: string, summary: string): string {
  return `**pisa** 自动评审 · PR #${pr} @ ${headSha.slice(0, 7)}\n\n${summary.trim().slice(0, 3000)}`;
}

/** 开放 PR 的评审所需字段 */
export interface PullSummary {
  number: number;
  headSha: string;
  title: string;
  baseRef: string;
  draft: boolean;
}

/** 目标仓库当前的开放 PR；草稿标记交给调用方决定是否跳过 */
export function listOpenPulls(runner: Runner, repo: string): GhResult<PullSummary[]> {
  const res = runner(["gh", "api", `repos/${repo}/pulls?state=open&per_page=100`, "--paginate", "--jq", ".[]"]);
  if (res.code !== 0) return { ok: false, error: res.err || res.out || `gh 退出码 ${res.code}` };
  const pulls: PullSummary[] = [];
  for (const line of res.out.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, error: `PR 解析失败：${text.slice(0, 200)}` };
    }
    const number = Number(raw["number"]);
    const head = raw["head"] as Record<string, unknown> | undefined;
    const base = raw["base"] as Record<string, unknown> | undefined;
    const headSha = String(head?.["sha"] ?? "");
    if (!Number.isSafeInteger(number) || number <= 0 || !headSha) continue;
    pulls.push({
      number,
      headSha,
      title: String(raw["title"] ?? ""),
      baseRef: String(base?.["ref"] ?? ""),
      draft: raw["draft"] === true,
    });
  }
  return { ok: true, value: pulls };
}

/** 评审任务的需求正文：审哪个 PR、代码在哪里、看什么、输出什么 */
export function reviewPrompt(repo: string, pr: Pick<PullSummary, "number" | "headSha" | "title" | "baseRef">): string {
  return [
    `自动评审 PR #${pr.number}（${repo}）`,
    "",
    `标题：${pr.title || "(无标题)"}`,
    `目标分支：${pr.baseRef || "(未知)"}`,
    `head 提交：${pr.headSha}`,
    "",
    "工作目录已用分离 HEAD 检出该 PR 的 head 提交，本次为只读评审：不改文件、不建分支、不提交。" +
      `完整差异可用 \`gh pr diff ${pr.number} --repo ${repo}\` 查看。`,
    "",
    "关注点：",
    "- 正确性与边界：改动是否覆盖真实输入范围，是否存在错位、空值与越界",
    "- 错误处理与并发：失败路径、资源释放、竞态与重试",
    "- 安全：注入、越权、密钥外泄、外部输入未校验",
    "- 测试：新行为是否有测试覆盖，测试能否真的失败",
    "- 一致性：是否重复实现已有能力，是否偏离仓库现有约定",
    "",
    "输出中文 Markdown：第一行给结论（可以合并 / 有阻塞问题 / 需要讨论），" +
      "随后按严重程度列出问题（文件与行号、问题、影响、建议），最后列出已确认没问题的部分。",
  ].join("\n");
}

/** 拉取 since 之后新增或更新的 Issue / PR 评论；逐行解析 `--jq '.[]'` 的输出 */
export function listComments(runner: Runner, repo: string, sinceIso: string): GhResult<PrComment[]> {
  const since = encodeURIComponent(sinceIso);
  const res = runner([
    "gh",
    "api",
    `repos/${repo}/issues/comments?since=${since}&per_page=100`,
    "--paginate",
    "--jq",
    ".[]",
  ]);
  if (res.code !== 0) return { ok: false, error: res.err || res.out || `gh 退出码 ${res.code}` };

  const comments: PrComment[] = [];
  for (const line of res.out.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, error: `评论解析失败：${text.slice(0, 200)}` };
    }
    const id = Number(raw["id"]);
    if (!Number.isSafeInteger(id)) continue;
    const user = raw["user"] as Record<string, unknown> | undefined;
    comments.push({
      id,
      body: String(raw["body"] ?? ""),
      issueUrl: String(raw["issue_url"] ?? ""),
      userLogin: String(user?.["login"] ?? ""),
    });
  }
  return { ok: true, value: comments };
}

/** 编号是 PR 还是普通 Issue：PR 对应的 issue 对象带 pull_request 字段 */
export function isPullRequest(runner: Runner, repo: string, n: number): GhResult<boolean> {
  const res = runner(["gh", "api", `repos/${repo}/issues/${n}`, "--jq", ".pull_request // empty"]);
  if (res.code !== 0) return { ok: false, error: res.err || res.out || `gh 退出码 ${res.code}` };
  return { ok: true, value: res.out.trim() !== "" };
}

/** 回帖的隐藏幂等标记：HTML 注释，GitHub 渲染时不可见；含任务号与用途 */
export function replyMarker(taskId: string, purpose: "pr" | "issue"): string {
  return `<!-- pisa:reply task=${taskId} on=${purpose} -->`;
}

/** 讨论串（PR 与 Issue 共用 issue 评论接口）的全部评论正文；`.[]` 逐行输出，正文里的换行被 JSON 转义，按行解析安全 */
function listThreadBodies(runner: Runner, repo: string, n: number): GhResult<string[]> {
  const res = runner(["gh", "api", `repos/${repo}/issues/${n}/comments`, "--paginate", "--jq", ".[]"]);
  if (res.code !== 0) return { ok: false, error: res.err || res.out || `gh 退出码 ${res.code}` };

  const bodies: string[] = [];
  for (const line of res.out.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      bodies.push(String(raw["body"] ?? ""));
    } catch {
      return { ok: false, error: `评论解析失败：${text.slice(0, 200)}` };
    }
  }
  return { ok: true, value: bodies };
}

export function postComment(runner: Runner, repo: string, pr: number, body: string): GhResult {
  const res = runner(["gh", "pr", "comment", String(pr), "--repo", repo, "--body", body]);
  if (res.code !== 0) return { ok: false, error: res.err || res.out || `gh 退出码 ${res.code}` };
  return { ok: true, value: undefined };
}

export function postIssueComment(runner: Runner, repo: string, issue: number, body: string): GhResult {
  const res = runner(["gh", "issue", "comment", String(issue), "--repo", repo, "--body", body]);
  if (res.code !== 0) return { ok: false, error: res.err || res.out || `gh 退出码 ${res.code}` };
  return { ok: true, value: undefined };
}

/** 幂等回帖的结果：posted 真发了，skipped 讨论串里已有同标记 */
export type ReplyOutcome = "posted" | "skipped";

/**
 * 带隐藏标记回帖：先查讨论串里是否已有同任务、同用途的标记，有则跳过。
 * 重试（进程重启后重跑同一任务）因此不会产生第二条评论。
 * 检查本身失败时无法确认是否已发，返回错误由调用方记日志，不发比重复发安全。
 */
export function postReplyOnce(
  runner: Runner,
  repo: string,
  n: number,
  purpose: "pr" | "issue",
  taskId: string,
  body: string,
): GhResult<ReplyOutcome> {
  const marker = replyMarker(taskId, purpose);
  const seen = listThreadBodies(runner, repo, n);
  if (!seen.ok) return { ok: false, error: `讨论串检查失败：${seen.error}` };
  if (seen.value.some((text) => text.includes(marker))) return { ok: true, value: "skipped" };

  const text = `${body}\n\n${marker}`;
  const res = purpose === "pr" ? postComment(runner, repo, n, text) : postIssueComment(runner, repo, n, text);
  return res.ok ? { ok: true, value: "posted" } : res;
}
