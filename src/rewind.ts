import { existsSync } from "node:fs";
import type { Effect, Task } from "./types";
import { closePr, prNumberFromIssueUrl, prRepoFromUrl, prStatus, type Runner } from "./github";
import { currentBranch, deleteBranch, removeWorktree, sh } from "./git";
import type { Store } from "./store";

/** 外部状态探测点：分支/工作副本是否还在，PR 是否已合并；测试注入假实现 */
export interface RewindProbes {
  branchExists(repoPath: string, branch: string): boolean;
  worktreeExists(path: string): boolean;
  prState(repo: string, n: number): { state: string; mergeCommit: string | null } | null;
}

export interface RewindContext {
  repoPath: string;
  baseBranch: string;
  probes: RewindProbes;
}

export type RewindAction =
  | { kind: "remove-worktree"; label: string; effect: Effect; repoPath: string; workdir: string }
  | {
      kind: "revert-merge";
      label: string;
      effect: Effect | null;
      repoPath: string;
      base: string;
      from: string | null;
      to: string | null;
      commit: string | null;
    }
  | { kind: "close-pr"; label: string; effect: Effect | null; repo: string; number: number }
  | { kind: "delete-remote-branch"; label: string; effect: Effect; repoPath: string; branch: string }
  | { kind: "delete-local-branch"; label: string; effect: Effect; repoPath: string; branch: string };

/** 合并状态：rewind 输出与动作选择都以此为准 */
export type MergeState = "merged" | "open" | "closed" | "none" | "unknown";

export interface RewindPlan {
  task: Task;
  merge: MergeState;
  actions: RewindAction[];
  /** 已经发生、无法撤回的副作用 */
  irreversible: string[];
  /** 有意保留的对象及原因 */
  notes: string[];
}

/** 合并状态的中文标签：CLI 预览、Web 预览与结果共用 */
export const MERGE_LABEL: Record<MergeState, string> = {
  merged: "已合并（用 revert 提交回退，不改写历史）",
  open: "未合并（PR 仍打开，将关闭）",
  closed: "未合并（PR 已关闭）",
  none: "未开 PR",
  unknown: "无法确认（gh 查询失败，为避免误删已合并分支，跳过撤销）",
};

interface MergeMeta {
  base?: string;
  from?: string;
  to?: string;
}

function parseMergeMeta(detail: string | null): MergeMeta {
  if (!detail) return {};
  try {
    const raw = JSON.parse(detail) as Record<string, unknown>;
    const pick = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
    return { base: pick("base"), from: pick("from"), to: pick("to") };
  } catch {
    return {};
  }
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "";
}

/**
 * 由任务与副作用账本推出撤销计划。只读：探测 PR 状态、分支与工作副本是否存在，
 * 不改动任何东西，供预览与执行共用。
 */
export function planRewind(task: Task, effects: Effect[], ctx: RewindContext): RewindPlan {
  const actions: RewindAction[] = [];
  const irreversible: string[] = [];
  const notes: string[] = [];

  const hasPr = Boolean(task.prUrl && prNumberFromIssueUrl(task.prUrl));
  const prNumber = hasPr ? prNumberFromIssueUrl(task.prUrl!) : null;
  const prRepo = task.prUrl ? prRepoFromUrl(task.prUrl) : null;
  const mergeEffect = effects.find((e) => e.kind === "merge") ?? null;
  const prState = prRepo && prNumber ? ctx.probes.prState(prRepo, prNumber) : null;
  const merged = mergeEffect !== null || prState?.state === "MERGED";
  const merge: MergeState = merged
    ? "merged"
    : prState
      ? prState.state === "CLOSED"
        ? "closed"
        : "open"
      : prNumber
        ? "unknown"
        : "none";

  for (const e of effects) {
    if (e.kind !== "worktree") continue;
    if (!ctx.probes.worktreeExists(e.target)) {
      notes.push(`工作副本已不存在：${e.target}`);
      continue;
    }
    actions.push({
      kind: "remove-worktree",
      effect: e,
      repoPath: ctx.repoPath,
      workdir: e.target,
      label: `移除工作副本 ${e.target}（未提交改动一并丢弃）`,
    });
  }

  if (merge === "merged") {
    const meta = parseMergeMeta(mergeEffect?.detail ?? null);
    const base = meta.base ?? ctx.baseBranch;
    const from = meta.from ?? null;
    const to = meta.to ?? null;
    // 有 pisa 自己合并时记录的提交区间就按区间回退；否则退回 gh 报告的合并提交
    const commit = from && to ? null : (prState?.mergeCommit ?? null);
    const target = from && to ? `${short(from)}..${short(to)}` : commit ? short(commit) : "合并提交";
    actions.push({
      kind: "revert-merge",
      effect: mergeEffect,
      repoPath: ctx.repoPath,
      base,
      from,
      to,
      commit,
      label: `在 ${base} 生成 revert 提交，回退 ${target}`,
    });
    notes.push("revert 只新增回退提交，原提交仍留在历史与 PR 里");
  } else if (merge === "open" && prRepo && prNumber) {
    const prEffect = effects.find((e) => e.kind === "pr" && e.target === String(prNumber)) ?? null;
    actions.push({
      kind: "close-pr",
      effect: prEffect,
      repo: prRepo,
      number: prNumber,
      label: `关闭 PR #${prNumber}（${task.prUrl}）`,
    });
  }

  // PR 状态查不到时无法区分「已合并」与「未合并」，删分支可能毁掉已合并成果
  if (merge !== "unknown") {
    // push 账本 target 是远程名，detail 是被推送的分支
    const pushes = new Map(effects.filter((e) => e.kind === "push").map((e) => [e.detail ?? "", e]));
    for (const e of effects) {
      if (e.kind !== "branch") continue;
      if (e.detail === "shared") {
        notes.push(`分支 ${e.target} 与上一轮任务共用，保留`);
        continue;
      }
      const push = pushes.get(e.target);
      if (push) {
        actions.push({
          kind: "delete-remote-branch",
          effect: push,
          repoPath: ctx.repoPath,
          branch: e.target,
          label: `删除远程分支 origin/${e.target}`,
        });
      }
      if (ctx.probes.branchExists(ctx.repoPath, e.target)) {
        actions.push({
          kind: "delete-local-branch",
          effect: e,
          repoPath: ctx.repoPath,
          branch: e.target,
          label: `删除本地分支 ${e.target}`,
        });
      }
    }
  } else if (effects.some((e) => e.kind === "branch")) {
    notes.push("PR 状态未知，分支保留；恢复 gh 可用后重试");
  }

  for (const e of effects) {
    if (e.kind !== "comment") continue;
    irreversible.push(`已发 ${e.target} 评论（${e.detail ?? "回帖"}），无法撤回`);
  }

  return { task, merge, actions, irreversible, notes };
}

export function formatRewindPlan(plan: RewindPlan, trigger: string): string {
  const lines = [
    `rewind 预览 · ${plan.task.id}`,
    `状态：${plan.task.status} · 仓库 ${plan.task.repo}`,
    `合并：${MERGE_LABEL[plan.merge]}`,
  ];
  if (plan.actions.length > 0) {
    lines.push("", `将执行（${plan.actions.length}）`);
    plan.actions.forEach((a, i) => lines.push(`${i + 1}. ${a.label}`));
  } else {
    lines.push("", "没有可撤销的副作用。");
  }
  if (plan.irreversible.length > 0) lines.push("", "不可撤销", ...plan.irreversible.map((s) => `- ${s}`));
  if (plan.notes.length > 0) lines.push("", "保留", ...plan.notes.map((s) => `- ${s}`));
  lines.push("", "账本只覆盖分支、推送、PR、回帖、工作副本、合并；执行期间的其它外部调用（API、消息、数据库）无法撤销。");
  lines.push("", `确认执行：${trigger} rewind ${plan.task.id} --yes`);
  return lines.join("\n");
}

export interface RewindOutcome {
  label: string;
  ok: boolean;
  error?: string;
  /** 成功执行后从账本删掉的副作用 */
  effect: Effect | null;
}

export interface RewindDeps {
  taskId: string;
  runner: Runner;
  commitName: string;
  commitEmail: string;
}

/** 逐条执行，失败不中断后续步骤：部分失败可修正后重试 */
export function applyRewind(plan: RewindPlan, deps: RewindDeps): RewindOutcome[] {
  return plan.actions.map((a) => ({ label: a.label, effect: a.effect, ...run(a, deps) }));
}

function run(a: RewindAction, deps: RewindDeps): { ok: boolean; error?: string } {
  switch (a.kind) {
    case "remove-worktree": {
      removeWorktree(a.repoPath, a.workdir);
      return existsSync(a.workdir) ? { ok: false, error: "工作副本仍然存在" } : { ok: true };
    }
    case "close-pr": {
      const res = closePr(deps.runner, a.repo, a.number);
      return res.ok ? { ok: true } : { ok: false, error: res.error.slice(0, 300) };
    }
    case "delete-remote-branch": {
      const res = sh(["git", "-C", a.repoPath, "push", "origin", "--delete", a.branch]);
      return res.code === 0 ? { ok: true } : { ok: false, error: (res.err || res.out).slice(0, 300) };
    }
    case "delete-local-branch": {
      deleteBranch(a.repoPath, a.branch);
      const gone = sh(["git", "-C", a.repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${a.branch}`]).code !== 0;
      return gone ? { ok: true } : { ok: false, error: `分支 ${a.branch} 仍存在` };
    }
    case "revert-merge":
      return revert(a, deps);
  }
}

/** 已合并任务的回退：在主干上生成一个 revert 提交，不改写历史 */
function revert(a: Extract<RewindAction, { kind: "revert-merge" }>, deps: RewindDeps): { ok: boolean; error?: string } {
  const cur = currentBranch(a.repoPath);
  if (cur !== a.base) return { ok: false, error: `主工作区在 ${cur}，需要先切到 ${a.base}` };

  let args: string[];
  if (a.from && a.to) {
    args = ["git", "-C", a.repoPath, "revert", "--no-commit", `${a.from}..${a.to}`];
  } else if (a.commit) {
    const parents = sh(["git", "-C", a.repoPath, "rev-list", "--parents", "-n", "1", a.commit]);
    if (parents.code !== 0) return { ok: false, error: `本地找不到合并提交 ${short(a.commit)}，先在主干 git pull` };
    const isMerge = parents.out.split(/\s+/).length > 2;
    args = ["git", "-C", a.repoPath, "revert", "--no-commit", ...(isMerge ? ["-m", "1"] : []), a.commit];
  } else {
    return { ok: false, error: "缺少可回退的提交信息" };
  }

  const rev = sh(args);
  if (rev.code !== 0) {
    sh(["git", "-C", a.repoPath, "revert", "--abort"]);
    return { ok: false, error: `回退失败：${(rev.err || rev.out).slice(0, 300)}` };
  }
  const commit = sh([
    "git",
    "-C",
    a.repoPath,
    "-c",
    `user.name=${deps.commitName}`,
    "-c",
    `user.email=${deps.commitEmail}`,
    "commit",
    "-m",
    `revert: 撤销 ${deps.taskId}`,
  ]);
  if (commit.code !== 0) {
    sh(["git", "-C", a.repoPath, "reset", "--merge"]);
    return { ok: false, error: `提交回退失败：${(commit.err || commit.out).slice(0, 300)}` };
  }
  return { ok: true };
}

/** 探测点：预览与执行都只读这些状态；CLI 与 Web 共用一份实现 */
export function rewindProbes(runner: Runner): RewindProbes {
  return {
    branchExists: (repoPath, branch) =>
      sh(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0,
    worktreeExists: (path) => existsSync(path),
    prState: (repo, n) => prStatus(runner, repo, n),
  };
}

/**
 * 逐条执行计划并把结果写回账本：
 * - 成功的副作用已不存在，从账本删掉；失败的保留以便重试
 * - 合并状态未知时不动任务状态；全部成功且状态可判定才置 rewound
 */
export function executeRewind(
  plan: RewindPlan,
  store: Store,
  deps: RewindDeps,
): { results: RewindOutcome[]; rewound: boolean } {
  const results = applyRewind(plan, deps);
  for (const r of results) {
    if (r.ok && r.effect) store.removeEffect(deps.taskId, r.effect.kind, r.effect.target);
  }
  const rewound = plan.merge !== "unknown" && results.every((r) => r.ok);
  if (rewound) store.transition(deps.taskId, "rewound");
  return { results, rewound };
}

/** 执行结果文本；没有动作时单独提示，避免给空列表配「已撤销」标题 */
export function formatRewindOutcome(plan: RewindPlan, results: RewindOutcome[]): string {
  if (results.length > 0) return formatRewindResult(plan, results);
  const lines = [
    plan.merge === "unknown" ? `未完成撤销 · ${plan.task.id}` : `已标记撤销 · ${plan.task.id}`,
    "没有需要执行的撤销动作。",
  ];
  if (plan.irreversible.length > 0) lines.push("", "不可撤销", ...plan.irreversible.map((s) => `- ${s}`));
  if (plan.notes.length > 0) lines.push("", "保留", ...plan.notes.map((s) => `- ${s}`));
  return lines.join("\n");
}

export function formatRewindResult(plan: RewindPlan, results: RewindOutcome[]): string {
  const failed = results.filter((r) => !r.ok);
  const incomplete = failed.length > 0 || plan.merge === "unknown";
  const lines = [
    failed.length > 0 ? `部分失败 · ${plan.task.id}` : incomplete ? `未完成 · ${plan.task.id}` : `已撤销 · ${plan.task.id}`,
  ];
  for (const r of results) lines.push(`${r.ok ? "✓" : "✗"} ${r.label}${r.ok ? "" : `：${r.error ?? "未知错误"}`}`);
  if (plan.irreversible.length > 0) lines.push("", "不可撤销", ...plan.irreversible.map((s) => `- ${s}`));
  if (plan.notes.length > 0) lines.push("", "保留", ...plan.notes.map((s) => `- ${s}`));
  if (incomplete) lines.push("", `修正后重试：/pisa rewind ${plan.task.id} --yes`);
  return lines.join("\n");
}
