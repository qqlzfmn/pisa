import type { Task } from "./types";
import { postComment, prNumberFromIssueUrl, prRepoFromUrl, prStatus, type GhResult, type Runner } from "./github";

/** 评审只看 diff 文本；超出部分截断并在提示词里标明，避免把上下文撑爆 */
const MAX_DIFF = 60_000;

/** CI 等待上限与轮询间隔：超时按未绿处理，不合并 */
export const DEFAULT_CI_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_CI_POLL_MS = 15_000;

export interface PullRequest {
  number: number;
  /** owner/repo */
  repo: string;
  url: string;
}

/** 归一化后的检查状态：CheckRun 的 conclusion 与 StatusContext 的 state 统一成一个字符串 */
export interface CiCheck {
  name: string;
  state: string;
}

export interface PrSnapshot {
  state: string;
  headSha: string;
  checks: CiCheck[];
}

export type CiState = "green" | "pending" | "failed" | "none";

/** 视为失败的结论；其余非成功状态一律按「还在跑」处理，直到超时 */
const FAILED_CONCLUSIONS: Record<string, true> = {
  FAILURE: true,
  CANCELLED: true,
  TIMED_OUT: true,
  ACTION_REQUIRED: true,
  STARTUP_FAILURE: true,
  ERROR: true,
  STALE: true,
};
const OK_CONCLUSIONS: Record<string, true> = { SUCCESS: true, NEUTRAL: true, SKIPPED: true };

/** 全部检查通过才算绿；没有检查、缺失结论都按未绿处理 */
export function ciVerdict(checks: CiCheck[]): { state: CiState; failing: string[] } {
  if (checks.length === 0) return { state: "none", failing: [] };
  const failing = checks.filter((c) => FAILED_CONCLUSIONS[c.state] === true).map((c) => c.name);
  if (failing.length > 0) return { state: "failed", failing };
  const pending = checks.filter((c) => OK_CONCLUSIONS[c.state] !== true);
  return pending.length > 0 ? { state: "pending", failing: [] } : { state: "green", failing: [] };
}

function normalizeChecks(raw: unknown): CiCheck[] {
  if (!Array.isArray(raw)) return [];
  const checks: CiCheck[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = String(o["name"] ?? o["context"] ?? "check");
    const status = typeof o["status"] === "string" ? o["status"] : "";
    const conclusion = typeof o["conclusion"] === "string" ? o["conclusion"] : "";
    const contextState = typeof o["state"] === "string" ? o["state"] : "";
    let state: string;
    if (status) state = status === "COMPLETED" ? conclusion || status : status;
    else state = contextState || "PENDING";
    checks.push({ name, state });
  }
  return checks;
}

/** 一次读齐合并判断需要的三个事实：PR 状态、head SHA、检查结果 */
export function snapshotPr(runner: Runner, repo: string, n: number): GhResult<PrSnapshot> {
  const res = runner([
    "gh",
    "pr",
    "view",
    String(n),
    "--repo",
    repo,
    "--json",
    "state,headRefOid,statusCheckRollup",
  ]);
  if (res.code !== 0) return { ok: false, error: res.err || res.out || `gh 退出码 ${res.code}` };
  try {
    const raw = JSON.parse(res.out) as Record<string, unknown>;
    const headSha = typeof raw["headRefOid"] === "string" ? raw["headRefOid"] : "";
    if (!headSha) return { ok: false, error: "PR 没有 head SHA" };
    return {
      ok: true,
      value: {
        state: String(raw["state"] ?? ""),
        headSha,
        checks: normalizeChecks(raw["statusCheckRollup"]),
      },
    };
  } catch {
    return { ok: false, error: "PR 状态解析失败" };
  }
}

export type WaitCi =
  | { ok: true; snapshot: PrSnapshot }
  | { ok: false; reason: string; failing: string[] };

/**
 * 轮询到 CI 全绿或超时。PR 已关闭、查询失败、检查为空、检查失败都立即返回，
 * 不让自动合并卡在无意义的重试上。
 */
export async function waitForCi(
  read: () => GhResult<PrSnapshot>,
  opts: { timeoutMs: number; intervalMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<WaitCi> {
  const sleep =
    opts.sleep ??
    ((ms: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    });
  const attempts = Math.max(1, Math.ceil(opts.timeoutMs / Math.max(1, opts.intervalMs)));
  for (let i = 0; i < attempts; i += 1) {
    const snap = read();
    if (!snap.ok) return { ok: false, reason: `查询 PR 失败：${snap.error}`, failing: [] };
    if (snap.value.state !== "OPEN") {
      return { ok: false, reason: `PR 状态是 ${snap.value.state || "未知"}，无法合并`, failing: [] };
    }
    const ci = ciVerdict(snap.value.checks);
    if (ci.state === "failed") return { ok: false, reason: "CI 未通过", failing: ci.failing };
    if (ci.state === "none") return { ok: false, reason: "PR 没有任何 CI 检查，无法确认全绿", failing: [] };
    if (ci.state === "green") return { ok: true, snapshot: snap.value };
    if (i < attempts - 1) await sleep(opts.intervalMs);
  }
  return { ok: false, reason: `等待 CI 超时（${Math.round(opts.timeoutMs / 1000)} 秒）`, failing: [] };
}

export interface ReviewInput {
  pr: PullRequest;
  headSha: string;
  diff: string;
  checks: CiCheck[];
  /** 仓库规范（AGENTS.md），评审的唯一主观标准来源 */
  standards: string;
}

/** 评审提示词：只给 diff、规范与 CI 结果，不给实现者的会话与自述 */
export function reviewPrompt(input: ReviewInput): string {
  const checks =
    input.checks.length > 0 ? input.checks.map((c) => `- ${c.name}: ${c.state}`).join("\n") : "- 无检查";
  const diff =
    input.diff.length > MAX_DIFF
      ? `${input.diff.slice(0, MAX_DIFF)}\n\n（diff 已截断，共 ${input.diff.length} 字符）`
      : input.diff;
  return [
    "你是 pisa 的独立评审者，没有参与实现。只读评审这个 PR，不要修改、提交或推送任何文件。",
    "",
    "## PR",
    `#${input.pr.number} ${input.pr.url}`,
    `head: ${input.headSha}`,
    "",
    "## CI",
    checks,
    "",
    "## 仓库规范",
    input.standards.trim() || "（仓库没有 AGENTS.md，按现有代码风格与最小改动判断）",
    "",
    "## 评审范围",
    "只看下面这份 diff；需要上下文时可以读工作目录里的文件，但不得写入。",
    "重点：正确性、边界条件、与需求是否一致、是否引入回归、是否违反仓库规范。",
    "",
    "```diff",
    diff,
    "```",
    "",
    "## 输出",
    "只输出一个 JSON 对象，不要任何其它文字：",
    '{"verdict":"pass|fail","blockers":["..."],"summary":"..."}',
    "verdict 为 fail 时 blockers 至少一条，写清文件与具体问题；pass 时 blockers 为空数组。",
  ].join("\n");
}

export interface ReviewVerdict {
  verdict: "pass" | "fail";
  blockers: string[];
  summary: string;
}

/** 从模型输出里取最后一个带 verdict 的 JSON 对象；围栏、解释文字都容忍 */
export function parseVerdict(text: string): ReviewVerdict | null {
  for (const candidate of jsonObjects(text).reverse()) {
    let raw: unknown;
    try {
      raw = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const verdict = o["verdict"];
    if (verdict !== "pass" && verdict !== "fail") continue;
    const blockers = Array.isArray(o["blockers"])
      ? o["blockers"].filter((b): b is string => typeof b === "string" && b.trim() !== "")
      : [];
    return { verdict, blockers, summary: typeof o["summary"] === "string" ? o["summary"] : "" };
  }
  return null;
}

/** 找出文本里所有平衡的 JSON 对象（跳过字符串内的括号与转义） */
function jsonObjects(text: string): string[] {
  const out: string[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

export interface ReviewRequest {
  pr: PullRequest;
  headSha: string;
  prompt: string;
}

/** 跑一次评审：由调用方提供工作副本与干净的 worker，返回原始输出 */
export type ReviewRunner = (req: ReviewRequest) => Promise<string>;

export interface AutoMergeDeps {
  runner: Runner;
  review: ReviewRunner;
  /** 仓库规范文本，可为空 */
  standards?: string;
  ciTimeoutMs?: number;
  ciPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type AutoMergeResult =
  | { status: "merged"; pr: PullRequest; mergeCommit: string | null }
  | { status: "blocked"; pr: PullRequest | null; reason: string; blockers: string[] }
  | { status: "skipped"; reason: string };

export function blockerComment(taskId: string, verdict: ReviewVerdict, headSha: string): string {
  const lines = ["**pisa 评审未通过**", "", verdict.summary.trim() || "评审判定 fail。"];
  if (verdict.blockers.length > 0) lines.push("", "阻塞项", ...verdict.blockers.map((b) => `- ${b}`));
  lines.push("", `head: \`${headSha}\``, `<!-- pisa:review task=${taskId} sha=${headSha} -->`);
  return lines.join("\n");
}

function truncateReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 600);
}

/**
 * 自动合并主流程：等 CI → 独立评审 → head SHA 未变 → squash 合并。
 * 任一步不满足都不合并；评审 fail 时把阻塞项写进 PR 评论。
 */
export async function autoMerge(task: Task, deps: AutoMergeDeps): Promise<AutoMergeResult> {
  if (!task.prUrl) return { status: "skipped", reason: "任务没有 PR，无法走 PR 合并" };
  const number = prNumberFromIssueUrl(task.prUrl);
  const repo = prRepoFromUrl(task.prUrl);
  if (!number || !repo) return { status: "skipped", reason: `PR 链接无法解析：${task.prUrl}` };
  const pr: PullRequest = { number, repo, url: task.prUrl };

  const ci = await waitForCi(() => snapshotPr(deps.runner, repo, number), {
    timeoutMs: deps.ciTimeoutMs ?? DEFAULT_CI_TIMEOUT_MS,
    intervalMs: deps.ciPollMs ?? DEFAULT_CI_POLL_MS,
    sleep: deps.sleep,
  });
  if (!ci.ok) {
    const detail = ci.failing.length > 0 ? `${ci.reason}：${ci.failing.join(", ")}` : ci.reason;
    return { status: "blocked", pr, reason: detail, blockers: ci.failing };
  }

  const diff = deps.runner(["gh", "pr", "diff", String(number), "--repo", repo]);
  if (diff.code !== 0) {
    return {
      status: "blocked",
      pr,
      reason: truncateReason(`拉取 PR diff 失败：${diff.err || diff.out || `gh 退出码 ${diff.code}`}`),
      blockers: [],
    };
  }

  let output: string;
  try {
    output = await deps.review({
      pr,
      headSha: ci.snapshot.headSha,
      prompt: reviewPrompt({
        pr,
        headSha: ci.snapshot.headSha,
        diff: diff.out,
        checks: ci.snapshot.checks,
        standards: deps.standards ?? "",
      }),
    });
  } catch (err) {
    return { status: "blocked", pr, reason: truncateReason(`评审失败：${(err as Error).message}`), blockers: [] };
  }

  const verdict = parseVerdict(output);
  if (!verdict) {
    const res = postComment(
      deps.runner,
      repo,
      number,
      `**pisa 评审输出无法解析，按未通过处理**\n\nhead: \`${ci.snapshot.headSha}\`\n\n${output.trim().slice(0, 2000)}`,
    );
    const note = res.ok ? "" : `；评论失败：${res.error}`;
    return { status: "blocked", pr, reason: `评审输出不是合法 verdict JSON${note}`, blockers: [] };
  }
  if (verdict.verdict === "fail") {
    const res = postComment(deps.runner, repo, number, blockerComment(task.id, verdict, ci.snapshot.headSha));
    const note = res.ok ? "" : `；评论失败：${res.error}`;
    return {
      status: "blocked",
      pr,
      reason: `评审未通过（${verdict.blockers.length} 条阻塞项）${note}`,
      blockers: verdict.blockers,
    };
  }

  // 评审期间 head 变了：评审结论不再对应待合并代码，直接放弃
  const after = snapshotPr(deps.runner, repo, number);
  if (!after.ok) {
    return { status: "blocked", pr, reason: `合并前复查失败：${after.error}`, blockers: [] };
  }
  if (after.value.headSha !== ci.snapshot.headSha) {
    return {
      status: "blocked",
      pr,
      reason: `评审后 head 已变化（${ci.snapshot.headSha.slice(0, 7)} → ${after.value.headSha.slice(0, 7)}）`,
      blockers: [],
    };
  }

  const merged = deps.runner([
    "gh",
    "pr",
    "merge",
    String(number),
    "--repo",
    repo,
    "--squash",
    "--delete-branch",
  ]);
  if (merged.code !== 0) {
    return {
      status: "blocked",
      pr,
      reason: truncateReason(`合并失败：${merged.err || merged.out || `gh 退出码 ${merged.code}`}`),
      blockers: [],
    };
  }
  const state = prStatus(deps.runner, repo, number);
  return { status: "merged", pr, mergeCommit: state?.mergeCommit ?? null };
}
