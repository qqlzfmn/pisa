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

/** 回帖正文：摘要截断到 3000 字 */
export function formatReply(summary: string): string {
  return `**pisa** 任务完成\n\n${summary.trim().slice(0, 3000)}`;
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

export function postComment(runner: Runner, repo: string, pr: number, body: string): GhResult {
  const res = runner(["gh", "pr", "comment", String(pr), "--repo", repo, "--body", body]);
  if (res.code !== 0) return { ok: false, error: res.err || res.out || `gh 退出码 ${res.code}` };
  return { ok: true, value: undefined };
}
