import { existsSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Task, TaskStatus } from "./types";
import { closePr, prNumberFromIssueUrl, type Runner } from "./github";
import { sh } from "./git";

/**
 * 资源对账：任务记录（DB）与实际资源（分支、工作副本、PR）逐项比对。
 * 计划是纯函数，实际状态由调用方探测后传入，测试直接构造。
 */

export type ReconcileKind = "worktree" | "local-branch" | "remote-branch" | "pr";

/** fixable 可清理；keep 有意保留；missing 任务需要但资源缺失；unknown 外部状态查不到 */
export type Disposition = "fixable" | "keep" | "missing" | "unknown";

export type ReconcileAction =
  | { kind: "remove-worktree"; repoPath: string | null; path: string }
  | { kind: "delete-local-branch"; repoPath: string; branch: string }
  | { kind: "delete-remote-branch"; repoPath: string; branch: string }
  | { kind: "close-pr"; repo: string; number: number };

export interface Finding {
  kind: ReconcileKind;
  /** 资源原始标识：分支名（不含 origin/）、工作副本绝对路径、PR 编号字符串 */
  target: string;
  /** 仓库别名；git 未登记的残留目录为 null */
  repo: string | null;
  /** 归属任务；没有任务记录时是从名字推出的任务号 */
  taskIds: string[];
  disposition: Disposition;
  note: string;
  action: ReconcileAction | null;
}

/** 一个仓库的实际状态，全部来自只读探测 */
export interface RepoReality {
  alias: string;
  repoPath: string;
  /** GitHub owner/repo；null 表示没有可查的 GitHub 远端 */
  slug: string | null;
  baseBranch: string;
  localBranches: string[];
  /** origin 下的分支名（不含 remote 前缀） */
  remoteBranches: string[];
  /** 打开的 PR；null 表示查询失败 */
  openPrs: Array<{ number: number; head: string }> | null;
}

/** 一个工作副本目录；git 未登记的残留目录 repo/repoPath 为 null */
export interface WorktreeReality {
  path: string;
  repo: string | null;
  repoPath: string | null;
  branch: string | null;
  /** 目录是否真的在磁盘上；git 还登记着、目录已被手工删掉时为 false */
  present?: boolean;
}

export interface ReconcileInput {
  tasks: Task[];
  repos: RepoReality[];
  worktrees: WorktreeReality[];
  /** 工作副本根目录：任务需要但目录不在时记为缺失 */
  worktreeRoot: string;
  /** 只对账这一任务号；null 表示全部 */
  scope?: string | null;
}

const ACTIVE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["queued", "running", "paused"]);

const STATUS_TEXT: Record<TaskStatus, string> = {
  queued: "排队",
  running: "运行中",
  paused: "暂停",
  succeeded: "成功",
  failed: "失败",
  cancelled: "取消",
  rewound: "已撤销",
};

/** pisa 自建分支前缀：`pisa/<任务号>` */
const BRANCH_PREFIX = "pisa/";

/** 工作副本目录名就是任务号；递归删目录时用它做最后一道闸门 */
const TASK_DIR = /^t_\d{8}_[0-9a-f]+$/;

const KIND_ORDER: Record<ReconcileKind, number> = {
  worktree: 0,
  "local-branch": 1,
  "remote-branch": 2,
  pr: 3,
};

interface Verdict {
  disposition: Disposition;
  note: string;
}

function describe(tasks: Task[]): string {
  return tasks.map((t) => `${t.id}（${STATUS_TEXT[t.status]}）`).join("、");
}

/**
 * 归属任务的处置规则：没结束的不动，成功待合并的不动（清理走 gc），
 * 其余的残留可清理；没有任务记录的资源按孤儿处理。
 */
function judge(owners: Task[]): Verdict {
  if (owners.length === 0) return { disposition: "fixable", note: "没有任务记录" };
  const active = owners.filter((t) => ACTIVE.has(t.status));
  if (active.length > 0) return { disposition: "keep", note: `任务 ${describe(active)} 还没结束，保留` };
  const succeeded = owners.filter((t) => t.status === "succeeded");
  if (succeeded.length > 0) {
    return { disposition: "keep", note: `任务 ${describe(succeeded)} 交付待合并，保留（清理用 gc）` };
  }
  return { disposition: "fixable", note: `任务 ${describe(owners)} 已结束，残留可清理` };
}

function derivedId(branch: string): string | null {
  return branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : null;
}

/**
 * 同一路径可能有软链与真实路径两种写法（macOS 的 /var 指向 /private/var），
 * 比较前统一成真实路径，否则会把已登记的工作副本当成孤儿。
 * 路径已被删掉时 realpath 会失败，就规范化最长的存在祖先再拼回剩余段，
 * 否则被删的工作副本同样会因两种写法对不上而漏报。
 */
export function realPath(path: string): string {
  const abs = resolve(path);
  let cur = abs;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    rest.unshift(basename(cur));
    cur = parent;
  }
  try {
    return join(realpathSync(cur), ...rest);
  } catch {
    return abs;
  }
}

export function planReconcile(input: ReconcileInput): Finding[] {
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const findings: Finding[] = [];
  // 只有磁盘上真在的目录才算工作副本存在；git 登记残留（手工删了目录）
  // 如果还按存在处理，运行中任务的缺失就永远查不出来
  const worktreePaths = new Set(
    input.worktrees.filter((w) => w.present !== false).map((w) => realPath(w.path)),
  );

  for (const w of input.worktrees) {
    const path = resolve(w.path);
    const id = basename(path);
    const task = byId.get(id);
    const owners = task ? [task] : [];
    const verdict = judge(owners);
    const absent = w.present === false;
    // 保留类的登记残留不虚报成一条工作副本：运行中/暂停任务的缺失由下面
    // 的反向差集报出，其余（成功待合并）的登记由 gc 的 prune 收拾
    if (absent && verdict.disposition === "keep") continue;
    findings.push({
      kind: "worktree",
      target: path,
      repo: w.repo,
      taskIds: [id],
      disposition: verdict.disposition,
      note: absent ? `${verdict.note}（登记残留，目录已不存在）` : verdict.note,
      action:
        verdict.disposition === "fixable" ? { kind: "remove-worktree", repoPath: w.repoPath, path } : null,
    });
  }

  for (const r of input.repos) {
    const repoTasks = input.tasks.filter((t) => t.repo === r.alias);

    // 分支归属：先按任务记录的分支名对，再按 pisa/<任务号> 推出的任务号对
    const ownersOfBranch = (branch: string): Task[] => {
      const direct = repoTasks.filter((t) => t.branch === branch);
      if (direct.length > 0) return direct;
      const id = derivedId(branch);
      const task = id ? byId.get(id) : undefined;
      return task ? [task] : [];
    };

    const branchFinding = (
      kind: "local-branch" | "remote-branch",
      branch: string,
      action: ReconcileAction,
    ): Finding | null => {
      const owners = ownersOfBranch(branch);
      const id = derivedId(branch);
      // 既不在任务记录里、又不是 pisa 分支的（如主干、手工分支）不归 pisa 管
      if (owners.length === 0 && id === null) return null;
      const verdict = judge(owners);
      const fixable = verdict.disposition === "fixable";
      return {
        kind,
        target: branch,
        repo: r.alias,
        taskIds: owners.length > 0 ? owners.map((t) => t.id) : [id!],
        disposition: verdict.disposition,
        note: verdict.note,
        action: fixable ? action : null,
      };
    };

    for (const branch of r.localBranches) {
      if (branch === r.baseBranch) continue;
      const f = branchFinding("local-branch", branch, {
        kind: "delete-local-branch",
        repoPath: r.repoPath,
        branch,
      });
      if (f) findings.push(f);
    }

    for (const branch of r.remoteBranches) {
      if (branch === r.baseBranch) continue;
      const f = branchFinding("remote-branch", branch, {
        kind: "delete-remote-branch",
        repoPath: r.repoPath,
        branch,
      });
      if (f) findings.push(f);
    }

    const hasArtifacts =
      repoTasks.some((t) => t.prUrl !== null) || r.localBranches.some((b) => derivedId(b) !== null);
    if (r.slug === null) {
      if (hasArtifacts) {
        findings.push({
          kind: "pr",
          target: "",
          repo: r.alias,
          taskIds: [],
          disposition: "unknown",
          note: "没有 GitHub 远端，跳过 PR 对账",
          action: null,
        });
      }
    } else if (r.openPrs === null) {
      if (hasArtifacts) {
        findings.push({
          kind: "pr",
          target: "",
          repo: r.alias,
          taskIds: [],
          disposition: "unknown",
          note: "gh 查询失败，跳过 PR 对账",
          action: null,
        });
      }
    } else {
      for (const pr of r.openPrs) {
        const byPr = repoTasks.filter((t) => t.prUrl !== null && prNumberFromIssueUrl(t.prUrl) === pr.number);
        const id = derivedId(pr.head);
        const owner = id ? byId.get(id) : undefined;
        const owners = byPr.length > 0 ? byPr : owner ? [owner] : [];
        // 既没绑到任务、head 也不是 pisa 分支的 PR 不是 pisa 建的
        if (owners.length === 0 && id === null) continue;
        const verdict = judge(owners);
        const fixable = verdict.disposition === "fixable";
        findings.push({
          kind: "pr",
          target: String(pr.number),
          repo: r.alias,
          taskIds: owners.length > 0 ? owners.map((t) => t.id) : [id!],
          disposition: verdict.disposition,
          note: verdict.note,
          action: fixable ? { kind: "close-pr", repo: r.slug, number: pr.number } : null,
        });
      }
    }

    // 反向差集：任务还需要工作副本（运行中、暂停可恢复），目录却没了
    for (const t of repoTasks) {
      if (t.status !== "running" && t.status !== "paused") continue;
      const dir = resolve(input.worktreeRoot, t.id);
      if (worktreePaths.has(realPath(dir))) continue;
      findings.push({
        kind: "worktree",
        target: dir,
        repo: r.alias,
        taskIds: [t.id],
        disposition: "missing",
        note: `任务 ${t.id}（${STATUS_TEXT[t.status]}）需要工作副本，但目录不存在`,
        action: null,
      });
    }
  }

  const sorted = findings.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.repo ?? "").localeCompare(b.repo ?? "") ||
      a.target.localeCompare(b.target),
  );
  const scope = input.scope ?? null;
  return scope ? sorted.filter((f) => f.taskIds.includes(scope)) : sorted;
}

export interface ReconcileOutcome {
  finding: Finding;
  ok: boolean;
  error?: string;
}

export interface ReconcileReport {
  scope: string | null;
  /** scope 是否真有任务记录；false 表示只核对了归属这个任务号的残留 */
  scopeRecorded: boolean;
  findings: Finding[];
  /** --fix 时的执行结果；预览为 null */
  outcomes: ReconcileOutcome[] | null;
  tasks: number;
  repos: number;
}

const DISPOSITION_TEXT: Record<Disposition, string> = {
  fixable: "可清理",
  keep: "保留",
  missing: "缺失",
  unknown: "无法确认",
};

const DISPOSITION_ORDER: readonly Disposition[] = ["fixable", "keep", "missing", "unknown"];

function label(f: Finding): string {
  const where = f.repo ? `[${f.repo}] ` : "";
  const what =
    f.kind === "pr"
      ? f.target
        ? `PR #${f.target}`
        : "PR"
      : f.kind === "remote-branch"
        ? `origin/${f.target}`
        : f.target;
  return `${where}${what}`;
}

export function formatReconcile(report: ReconcileReport, trigger: string): string {
  const { findings, outcomes } = report;
  const counts = new Map<Disposition, number>();
  for (const f of findings) counts.set(f.disposition, (counts.get(f.disposition) ?? 0) + 1);

  const head = report.scope
    ? `reconcile · ${report.scope}${report.scopeRecorded ? "" : "（没有任务记录）"}`
    : `reconcile · 全部任务（${report.repos} 个仓库，${report.tasks} 个任务）`;
  const lines = [
    head,
    DISPOSITION_ORDER.map((d) => `${DISPOSITION_TEXT[d]} ${counts.get(d) ?? 0}`).join(" · "),
  ];

  for (const d of DISPOSITION_ORDER) {
    const rows = findings.filter((f) => f.disposition === d);
    if (rows.length === 0) continue;
    lines.push("", `${outcomes ? (d === "fixable" ? "清理结果" : DISPOSITION_TEXT[d]) : DISPOSITION_TEXT[d]}（${rows.length}）`);
    for (const f of rows) {
      const outcome = outcomes?.find((o) => o.finding === f);
      const mark = outcome ? (outcome.ok ? "✓ " : "✗ ") : "";
      const tail = outcome && !outcome.ok && outcome.error ? `：${outcome.error}` : ` · ${f.note}`;
      lines.push(`- ${mark}${label(f)}${tail}`);
    }
  }

  const scopeArg = report.scope ? ` ${report.scope}` : "";
  if (outcomes) {
    const failed = outcomes.filter((o) => !o.ok).length;
    lines.push(
      "",
      failed > 0
        ? `清理完成，${failed} 项失败；修正后重试：${trigger} reconcile${scopeArg} --fix`
        : "清理完成。",
    );
    return lines.join("\n");
  }
  const fixable = counts.get("fixable") ?? 0;
  if (fixable > 0) lines.push("", `执行清理：${trigger} reconcile${scopeArg} --fix`);
  else if (findings.length === 0) lines.push("", "没有发现差异。");
  return lines.join("\n");
}

export interface ReconcileApplyDeps {
  runner: Runner;
  /** 工作副本根目录：只在这里递归删目录 */
  worktreeRoot: string;
}

/** 逐条执行，失败不中断后续：部分失败能修正后重试 */
export function applyReconcile(findings: Finding[], deps: ReconcileApplyDeps): ReconcileOutcome[] {
  const outcomes: ReconcileOutcome[] = [];
  for (const f of findings) {
    if (!f.action) continue;
    outcomes.push({ finding: f, ...run(f.action, deps) });
  }
  return outcomes;
}

function run(action: ReconcileAction, deps: ReconcileApplyDeps): { ok: boolean; error?: string } {
  switch (action.kind) {
    case "remove-worktree": {
      // 登记还在时先让 git 自己摘；摘不掉（登记失效、路径软链不同）就直接删目录，
      // 再 prune 掉失效登记 —— 否则分支仍被「某个工作副本占用」，后面删分支会失败
      const res = action.repoPath
        ? sh(["git", "-C", action.repoPath, "worktree", "remove", "--force", action.path])
        : null;
      removeDir(action.path, deps.worktreeRoot);
      if (action.repoPath) sh(["git", "-C", action.repoPath, "worktree", "prune"]);
      if (existsSync(action.path)) {
        return { ok: false, error: (res?.err || res?.out || "工作副本删不掉").slice(0, 300) };
      }
      return { ok: true };
    }
    case "delete-local-branch": {
      const res = sh(["git", "-C", action.repoPath, "branch", "-D", action.branch]);
      return res.code === 0 ? { ok: true } : { ok: false, error: (res.err || res.out).slice(0, 300) };
    }
    case "delete-remote-branch": {
      const res = sh(["git", "-C", action.repoPath, "push", "origin", "--delete", action.branch]);
      return res.code === 0 ? { ok: true } : { ok: false, error: (res.err || res.out).slice(0, 300) };
    }
    case "close-pr": {
      const res = closePr(deps.runner, action.repo, action.number);
      return res.ok ? { ok: true } : { ok: false, error: res.error.slice(0, 300) };
    }
  }
}

/** 只在工作副本根目录下、名字是任务号的目录上递归删除 */
function removeDir(path: string, root: string): void {
  const dir = realPath(path);
  if (dir.startsWith(`${realPath(root)}${sep}`) && TASK_DIR.test(basename(dir))) {
    rmSync(dir, { recursive: true, force: true });
  }
}
