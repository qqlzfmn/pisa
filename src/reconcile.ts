import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { EffectKind, Task, TaskStatus } from "./types";
import { closePr, prNumberFromIssueUrl, prRepoFromUrl, type Runner } from "./github";
import { deleteBranch, removeWorktree, sh } from "./git";

/** 资源类型与清理动作一一对应；fixable=false 时只作为差异报告 */
export type ReconcileAction = "remove-worktree" | "delete-branch" | "delete-remote-branch" | "close-pr";

const RESOURCE: Record<ReconcileAction, string> = {
  "remove-worktree": "工作副本",
  "delete-branch": "本地分支",
  "delete-remote-branch": "远程分支",
  "close-pr": "开放 PR",
};

const VERB: Record<ReconcileAction, string> = {
  "remove-worktree": "移除工作副本",
  "delete-branch": "删除本地分支",
  "delete-remote-branch": "删除远程分支",
  "close-pr": "关闭 PR",
};

/** pisa 自建分支前缀：只有这个前缀下的无名资源才算孤儿 */
const BRANCH_PREFIX = "pisa/";

/** 运行中的任务可能刚被 claim、还没建好工作副本，留出宽限 */
const WORKTREE_GRACE_MS = 30_000;

const MAX_ITEMS = 40;
const MAX_RETAINED = 15;

/** 执行顺序：先关 PR 再删它的头分支，避免 PR 因分支消失而无法再关闭 */
const ACTION_ORDER: Record<ReconcileAction, number> = {
  "remove-worktree": 0,
  "delete-branch": 1,
  "close-pr": 2,
  "delete-remote-branch": 3,
};

export interface RepoRef {
  alias: string;
  path: string;
}

/** 外部状态探测点：分支、工作副本与开放 PR；测试注入假实现 */
export interface ReconcileProbes {
  /** remote 为 null 表示查询不到 origin（离线或无远程），此时不判断远程分支；整体 null 表示仓库不可读 */
  branches(repoPath: string): { local: string[]; remote: string[] | null } | null;
  worktrees(repoPath: string): string[];
  openPrs(repoPath: string): Array<{ branch: string; url: string }> | null;
}

export interface ReconcileContext {
  stateDir: string;
  repos: RepoRef[];
  probes: ReconcileProbes;
  now?: number;
}

export interface ReconcileItem {
  action: ReconcileAction;
  /** 关联任务；孤儿资源为 null */
  taskId: string | null;
  status: TaskStatus | null;
  /** 仓库别名；未登记的残留工作副本为 null */
  repo: string | null;
  /** 路径、分支名或 PR 链接 */
  target: string;
  fixable: boolean;
  note: string;
}

export interface ReconcilePlan {
  taskId: string | null;
  scanned: number;
  items: ReconcileItem[];
  /** 有意保留的资源及原因 */
  retained: string[];
  /** 探测受限等说明 */
  notes: string[];
}

interface Snapshot {
  repo: RepoRef;
  local: Set<string>;
  remote: Set<string> | null;
  /** 规范化后的绝对路径 */
  worktrees: string[];
  open: Array<{ branch: string; url: string }> | null;
}

function isLive(status: TaskStatus): boolean {
  return status === "queued" || status === "running" || status === "paused";
}

function branchKey(repo: string, branch: string): string {
  return `${repo}\0${branch}`;
}

function worktreeRoot(stateDir: string): string {
  return resolve(stateDir, "worktrees");
}

/** `<stateDir>/worktrees/<任务号>` 返回任务号；其它路径（含 merge 的 verify 副本）返回 null */
function taskIdOfWorktree(stateDir: string, path: string): string | null {
  const root = worktreeRoot(stateDir);
  const p = resolve(path);
  if (!p.startsWith(root + sep)) return null;
  const rel = p.slice(root.length + 1);
  return rel && !rel.includes(sep) ? rel : null;
}

function snapshot(ctx: ReconcileContext, repo: RepoRef): Snapshot | null {
  const branches = ctx.probes.branches(repo.path);
  if (!branches) return null;
  return {
    repo,
    local: new Set(branches.local),
    remote: branches.remote ? new Set(branches.remote) : null,
    worktrees: ctx.probes.worktrees(repo.path).map((p) => resolve(p)),
    open: ctx.probes.openPrs(repo.path),
  };
}

interface Planner {
  ctx: ReconcileContext;
  now: number;
  inUse(repo: string, branch: string, taskId: string): boolean;
  push(item: ReconcileItem): void;
  retained: string[];
}

/** 工作副本：运行中的保留；已结束的残留可清理；暂停/失联的缺失只报告 */
function planWorktree(planner: Planner, task: Task, repo: RepoRef, snap: Snapshot): void {
  const workdir = resolve(planner.ctx.stateDir, "worktrees", task.id);
  const exists = snap.worktrees.includes(workdir) || existsSync(workdir);
  const base = {
    action: "remove-worktree" as const,
    taskId: task.id,
    status: task.status,
    repo: repo.alias,
    target: workdir,
  };
  if (isLive(task.status)) {
    if (exists) {
      planner.retained.push(`工作副本 ${workdir} · ${task.id} ${task.status} · 任务未结束`);
    } else if (task.status === "paused") {
      planner.push({ ...base, fixable: false, note: "工作副本缺失，恢复前需要重新创建" });
    } else if (task.status === "running" && (task.startedAt ?? planner.now) <= planner.now - WORKTREE_GRACE_MS) {
      planner.push({ ...base, fixable: false, note: "工作副本缺失，任务可能已失控" });
    }
  } else if (exists) {
    planner.push({ ...base, fixable: true, note: "任务已结束，工作副本未清理" });
  }
}

/** 分支：成功的保留待交付；已结束的只删自建且无人在用的；共用分支永久保留 */
function planBranches(planner: Planner, task: Task, repo: RepoRef, snap: Snapshot): void {
  const branch = task.branch;
  if (!branch) return;
  const local = snap.local.has(branch);
  const remote = snap.remote?.has(branch) ?? false;
  const remoteKnown = snap.remote !== null;
  if (isLive(task.status)) {
    if (local || remote || !remoteKnown) {
      planner.retained.push(`分支 ${branch} · ${task.id} ${task.status} · 任务依赖`);
    } else {
      planner.push({
        action: "delete-branch",
        taskId: task.id,
        status: task.status,
        repo: repo.alias,
        target: branch,
        fixable: false,
        note: "任务记录有分支，但本地与远程都不存在",
      });
    }
    return;
  }
  if (task.status === "succeeded") {
    if (local) planner.retained.push(`本地分支 ${branch} · ${task.id} succeeded · 等待合并或 rewind`);
    if (remote) planner.retained.push(`远程分支 ${branch} · ${task.id} succeeded · 等待合并`);
    return;
  }
  if (task.status !== "failed" && task.status !== "cancelled" && task.status !== "rewound") return;
  if (branch !== `${BRANCH_PREFIX}${task.id}`) {
    planner.retained.push(`共用分支 ${branch} · ${task.id} ${task.status} · 非本任务自建`);
    return;
  }
  if (planner.inUse(repo.alias, branch, task.id)) {
    planner.retained.push(`分支 ${branch} · ${task.id} ${task.status} · 仍被未结束或已完成的任务使用`);
    return;
  }
  const base = { taskId: task.id, status: task.status, repo: repo.alias, target: branch, fixable: true };
  if (local) planner.push({ ...base, action: "delete-branch", note: "任务已结束且未交付，本地分支残留" });
  if (remote) {
    planner.push({ ...base, action: "delete-remote-branch", note: "任务已结束且未交付，远程分支残留" });
  }
}

/** PR：成功的保留待合并；已结束的只关按链接或自建分支认领到的；探测失败时整段跳过 */
function planPr(planner: Planner, task: Task, repo: RepoRef, snap: Snapshot): void {
  if (snap.open === null) return;
  const branch = task.branch;
  const prUrl = task.prUrl?.trim().replace(/\/+$/, "");
  const byUrl = prUrl ? snap.open.find((p) => p.url.trim().replace(/\/+$/, "") === prUrl) : undefined;
  const byBranch = branch ? snap.open.find((p) => p.branch === branch) : undefined;
  const openPr = byUrl ?? byBranch;
  if (!openPr) return;
  if (task.status === "succeeded") {
    planner.retained.push(`PR ${openPr.url} · ${task.id} succeeded · 等待合并`);
    return;
  }
  if (isLive(task.status)) {
    planner.retained.push(`PR ${openPr.url} · ${task.id} ${task.status} · 任务未结束`);
    return;
  }
  if (task.status !== "failed" && task.status !== "cancelled" && task.status !== "rewound") return;
  const owned = branch === `${BRANCH_PREFIX}${task.id}` && !planner.inUse(repo.alias, branch, task.id);
  if (!owned) {
    planner.retained.push(`PR ${openPr.url} · ${task.id} ${task.status} · 分支不属于该任务`);
    return;
  }
  planner.push({
    action: "close-pr",
    taskId: task.id,
    status: task.status,
    repo: repo.alias,
    target: openPr.url,
    fixable: true,
    note: "任务已结束且未交付，PR 仍打开",
  });
}

function orphanWorktrees(planner: Planner, snaps: Map<string, Snapshot | null>, known: Set<string>): void {
  const push = (repo: string | null, path: string, note: string): void => {
    planner.push({ action: "remove-worktree", taskId: null, status: null, repo, target: path, fixable: true, note });
  };
  for (const snap of snaps.values()) {
    if (!snap) continue;
    for (const path of snap.worktrees) {
      const id = taskIdOfWorktree(planner.ctx.stateDir, path);
      if (id && !known.has(id)) push(snap.repo.alias, path, "任务表里没有这条记录，工作副本残留");
    }
  }
  try {
    for (const entry of readdirSync(worktreeRoot(planner.ctx.stateDir), { withFileTypes: true })) {
      if (!entry.isDirectory() || known.has(entry.name)) continue;
      push(null, resolve(worktreeRoot(planner.ctx.stateDir), entry.name), "任务表里没有这条记录，工作副本目录残留");
    }
  } catch {
    // worktrees 目录不存在：没有残留可查
  }
}

function orphanBranches(
  planner: Planner,
  snaps: Map<string, Snapshot | null>,
  known: Set<string>,
  referenced: Set<string>,
): void {
  const push = (repo: string, action: "delete-branch" | "delete-remote-branch", branch: string): void => {
    if (!branch.startsWith(BRANCH_PREFIX)) return;
    if (known.has(branch.slice(BRANCH_PREFIX.length)) || referenced.has(branchKey(repo, branch))) return;
    const note = action === "delete-branch" ? "本地分支残留" : "远程分支残留";
    planner.push({ action, taskId: null, status: null, repo, target: branch, fixable: true, note: `任务表里没有这条记录，${note}` });
  };
  for (const snap of snaps.values()) {
    if (!snap) continue;
    for (const branch of snap.local) push(snap.repo.alias, "delete-branch", branch);
    for (const branch of snap.remote ?? []) push(snap.repo.alias, "delete-remote-branch", branch);
  }
}

function orphanPrs(
  planner: Planner,
  snaps: Map<string, Snapshot | null>,
  known: Set<string>,
  referenced: Set<string>,
): void {
  for (const snap of snaps.values()) {
    if (!snap || snap.open === null) continue;
    for (const pr of snap.open) {
      if (!pr.branch.startsWith(BRANCH_PREFIX)) continue;
      if (known.has(pr.branch.slice(BRANCH_PREFIX.length)) || referenced.has(branchKey(snap.repo.alias, pr.branch))) {
        continue;
      }
      const note = "任务表里没有这条记录，PR 仍打开";
      planner.push({ action: "close-pr", taskId: null, status: null, repo: snap.repo.alias, target: pr.url, fixable: true, note });
    }
  }
}

function buildSnapshots(
  ctx: ReconcileContext,
  repos: RepoRef[],
  notes: string[],
): Map<string, Snapshot | null> {
  const snaps = new Map<string, Snapshot | null>();
  for (const repo of repos) {
    const snap = snapshot(ctx, repo);
    snaps.set(repo.alias, snap);
    if (!snap) {
      notes.push(`仓库不是 git 仓库或无法读取分支：${repo.alias}（${repo.path}）`);
      continue;
    }
    if (snap.remote === null) notes.push(`远程分支未核对（无法查询 origin）：${repo.alias}`);
    if (snap.open === null) notes.push(`PR 未核对（gh 不可用或查询失败）：${repo.alias}`);
  }
  return snaps;
}

function planTasks(
  planner: Planner,
  scanned: Task[],
  snaps: Map<string, Snapshot | null>,
  notes: string[],
): void {
  const missingRepo = new Set<string>();
  for (const task of scanned) {
    const repo = planner.ctx.repos.find((r) => r.alias === task.repo);
    if (!repo) {
      if (!missingRepo.has(task.repo)) {
        missingRepo.add(task.repo);
        notes.push(`仓库未配置，任务 ${task.id} 的资源未核对：${task.repo}`);
      }
      continue;
    }
    const snap = snaps.get(repo.alias);
    if (!snap) continue;
    planWorktree(planner, task, repo, snap);
    planBranches(planner, task, repo, snap);
    planPr(planner, task, repo, snap);
  }
}

/**
 * 由任务记录与仓库现状推出对账计划。只读：不删分支、不动工作副本、不关 PR，
 * 预览与 `--fix` 共用同一份计划。
 *
 * 判定口径：
 * - queued/running/paused 的资源一律保留，缺工作副本或分支只报告；
 * - succeeded 的分支与 PR 是待交付成果，保留；
 * - failed/cancelled/rewound 只清理本任务自建（`pisa/<任务号>`）且无人再用的资源；
 * - 全局模式下，`pisa/` 前缀下在任务表里找不到记录的资源视为孤儿。
 */
export function planReconcile(tasks: Task[], only: string | null, ctx: ReconcileContext): ReconcilePlan {
  const now = ctx.now ?? Date.now();
  const scanned = only ? tasks.filter((t) => t.id === only) : tasks;
  const branchUse = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.branch) continue;
    const key = branchKey(t.repo, t.branch);
    const list = branchUse.get(key) ?? [];
    list.push(t);
    branchUse.set(key, list);
  }
  const inUse = (repo: string, branch: string, taskId: string): boolean =>
    (branchUse.get(branchKey(repo, branch)) ?? []).some(
      (t) => t.id !== taskId && (isLive(t.status) || t.status === "succeeded"),
    );

  const items: ReconcileItem[] = [];
  const retained: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const push = (item: ReconcileItem): void => {
    const key = `${item.action}\0${item.repo ?? ""}\0${item.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  const scopeRepos = only ? ctx.repos.filter((r) => scanned.some((t) => t.repo === r.alias)) : ctx.repos;
  const snaps = buildSnapshots(ctx, scopeRepos, notes);
  const planner: Planner = { ctx, now, inUse, push, retained };
  planTasks(planner, scanned, snaps, notes);

  if (!only) {
    const known = new Set(tasks.map((t) => t.id));
    const referenced = new Set<string>();
    for (const t of tasks) if (t.branch) referenced.add(branchKey(t.repo, t.branch));
    orphanWorktrees(planner, snaps, known);
    orphanBranches(planner, snaps, known, referenced);
    orphanPrs(planner, snaps, known, referenced);
  }

  items.sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action]);
  return { taskId: only, scanned: scanned.length, items, retained, notes };
}

export interface ReconcileDeps {
  stateDir: string;
  /** 仓库别名 → 路径；未配置返回 null */
  repoPath(alias: string | null): string | null;
  runner: Runner;
  /** 清理成功后从账本删掉对应副作用，避免 rewind 重复处理 */
  forget?(taskId: string, kind: EffectKind, target: string): void;
}

export interface ReconcileOutcome {
  item: ReconcileItem;
  ok: boolean;
  error?: string;
}

const FORGET: Record<ReconcileAction, (target: string) => { kind: EffectKind; target: string } | null> = {
  "remove-worktree": (target) => ({ kind: "worktree", target }),
  "delete-branch": (target) => ({ kind: "branch", target }),
  "delete-remote-branch": () => ({ kind: "push", target: "origin" }),
  "close-pr": (target) => {
    const n = prNumberFromIssueUrl(target);
    return n ? { kind: "pr", target: String(n) } : null;
  },
};

/** 逐条执行；失败不中断后续，便于修正后重试 */
export function applyReconcile(plan: ReconcilePlan, deps: ReconcileDeps): ReconcileOutcome[] {
  return plan.items
    .filter((item) => item.fixable)
    .map((item) => {
      const result = run(item, deps);
      if (result.ok && item.taskId) {
        const effect = FORGET[item.action](item.target);
        if (effect) deps.forget?.(item.taskId, effect.kind, effect.target);
      }
      return { item, ...result };
    });
}

function run(item: ReconcileItem, deps: ReconcileDeps): { ok: boolean; error?: string } {
  switch (item.action) {
    case "remove-worktree": {
      const repoPath = deps.repoPath(item.repo);
      if (repoPath) removeWorktree(repoPath, item.target);
      // 未登记在 git 里的残留目录，git 删不掉；只在 stateDir/worktrees 内兜底
      const root = worktreeRoot(deps.stateDir);
      const path = resolve(item.target);
      if (existsSync(item.target) && (path === root || path.startsWith(root + sep))) {
        rmSync(item.target, { recursive: true, force: true });
      }
      return existsSync(item.target) ? { ok: false, error: "工作副本仍然存在" } : { ok: true };
    }
    case "delete-branch": {
      const repoPath = deps.repoPath(item.repo);
      if (!repoPath) return { ok: false, error: `仓库未配置：${item.repo ?? "未知"}` };
      deleteBranch(repoPath, item.target);
      const gone =
        sh(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${item.target}`]).code !== 0;
      return gone ? { ok: true } : { ok: false, error: `分支 ${item.target} 仍存在` };
    }
    case "delete-remote-branch": {
      const repoPath = deps.repoPath(item.repo);
      if (!repoPath) return { ok: false, error: `仓库未配置：${item.repo ?? "未知"}` };
      const res = sh(["git", "-C", repoPath, "push", "origin", "--delete", item.target]);
      return res.code === 0 ? { ok: true } : { ok: false, error: (res.err || res.out).slice(0, 300) };
    }
    case "close-pr": {
      const repo = prRepoFromUrl(item.target);
      const n = prNumberFromIssueUrl(item.target);
      if (!repo || !n) return { ok: false, error: "无法从链接解析 PR" };
      const res = closePr(deps.runner, repo, n);
      return res.ok ? { ok: true } : { ok: false, error: res.error.slice(0, 300) };
    }
  }
}

function describe(item: ReconcileItem): string {
  const owner = item.taskId ? `${item.taskId} ${item.status ?? ""}`.trim() : "无任务记录";
  const repo = item.repo ? ` · ${item.repo}` : "";
  return `${RESOURCE[item.action]} ${item.target}${repo} · ${owner} · ${item.note}`;
}

export function formatReconcilePlan(plan: ReconcilePlan, trigger: string): string {
  const fixable = plan.items.filter((i) => i.fixable);
  const report = plan.items.filter((i) => !i.fixable);
  const scope = plan.taskId ? `任务 ${plan.taskId}` : `全部任务（${plan.scanned}）`;
  const lines = [`reconcile · ${scope}`];

  if (fixable.length > 0) {
    lines.push("", `可清理（${fixable.length}）`);
    for (const item of fixable.slice(0, MAX_ITEMS)) lines.push(`- ${describe(item)}`);
    if (fixable.length > MAX_ITEMS) lines.push(`- … 其余 ${fixable.length - MAX_ITEMS} 项`);
  }
  if (report.length > 0) {
    lines.push("", `差异（${report.length}，只报告）`);
    for (const item of report.slice(0, MAX_ITEMS)) lines.push(`- ${describe(item)}`);
    if (report.length > MAX_ITEMS) lines.push(`- … 其余 ${report.length - MAX_ITEMS} 项`);
  }
  if (plan.items.length === 0) lines.push("", "没有发现差异。");
  if (plan.retained.length > 0) {
    lines.push("", "保留");
    for (const note of plan.retained.slice(0, MAX_RETAINED)) lines.push(`- ${note}`);
    if (plan.retained.length > MAX_RETAINED) lines.push(`- … 其余 ${plan.retained.length - MAX_RETAINED} 项`);
  }
  if (plan.notes.length > 0) lines.push("", "说明", ...plan.notes.map((n) => `- ${n}`));
  if (fixable.length > 0) {
    lines.push("", `执行清理：${trigger} reconcile${plan.taskId ? ` ${plan.taskId}` : ""} --fix`);
  }
  return lines.join("\n");
}

export function formatReconcileResult(plan: ReconcilePlan, results: ReconcileOutcome[]): string {
  const failed = results.filter((r) => !r.ok);
  const lines = [`已清理 · ${results.length - failed.length}/${results.length}${plan.taskId ? ` · ${plan.taskId}` : ""}`];
  for (const r of results) {
    const who = r.item.repo ? `（${r.item.repo}）` : "";
    lines.push(`${r.ok ? "✓" : "✗"} ${VERB[r.item.action]} ${r.item.target}${who}${r.ok ? "" : `：${r.error ?? "未知错误"}`}`);
  }
  if (failed.length > 0) lines.push("", `修正后重试：/pisa reconcile${plan.taskId ? ` ${plan.taskId}` : ""} --fix`);
  return lines.join("\n");
}
