import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { RepoConfig } from "./config";
import type { Store } from "./store";
import type { Effect, EffectKind, Task, TaskStatus } from "./types";
import { closePr, type Runner } from "./github";
import { deleteBranch, remoteRepo, remoteUrl, removeWorktree, sh, type ExecResult } from "./git";

/** 分支前缀与任务号共同决定资源归属：`pisa/<任务号>` */
export const BRANCH_PREFIX = "pisa/";

/** 任务仍可能继续使用资源的状态；任何清理都必须跳过 */
const ACTIVE: Partial<Record<TaskStatus, true>> = { queued: true, running: true, paused: true };

/** 任务号形态：与 Router.newId 一致，避免把随意目录当成任务残留 */
const TASK_ID = /^t_\d{8}_[0-9a-f]+$/;

export function isTaskId(value: string): boolean {
  return TASK_ID.test(value);
}

function taskIdOfBranch(branch: string): string | null {
  if (!branch.startsWith(BRANCH_PREFIX)) return null;
  const id = branch.slice(BRANCH_PREFIX.length);
  return TASK_ID.test(id) ? id : null;
}

export interface WorktreeEntry {
  path: string;
  /** 注册该工作副本的仓库；目录存在但未注册时为 null */
  repoPath: string | null;
  /** git 登记为 locked：调用方不得删除 */
  locked: boolean;
  /** 已登记但目录已被删掉：只需 prune 登记 */
  stale: boolean;
}

export interface OpenPr {
  number: number;
  head: string;
  url: string;
  /** owner/repo；从远程地址解析 */
  repo: string;
}

/** 外部状态探测点：测试注入假实现，不碰真实 git/gh */
export interface ReconcileProbes {
  /** 本地 pisa/* 分支；查询失败返回 null */
  localBranches(repoPath: string): string[] | null;
  /** 远程 pisa/* 分支；没有 origin 或离线返回 null */
  remoteBranches(repoPath: string): string[] | null;
  /** 状态目录下的工作副本，含未注册到 git 的目录 */
  worktrees(stateDir: string): WorktreeEntry[];
  /** 打开的 PR；gh 不可用或非 GitHub 返回 null */
  openPrs(repoPath: string): OpenPr[] | null;
}

/** 用真实 git/gh 实现探测点；PR 查询走注入的 Runner，便于测试 */
export function localReconcileProbes(deps: {
  repos: RepoConfig[];
  stateDir: string;
  runner: Runner;
}): ReconcileProbes {
  const repoByPath = new Map(deps.repos.map((r) => [resolve(r.path), r]));

  return {
    localBranches(repoPath) {
      // 用全名再裁前缀：%(refname:short) 遇到同名 tag 会输出 heads/pisa/x，解析不出任务号
      const res = sh(["git", "-C", repoPath, "for-each-ref", "--format=%(refname)", `refs/heads/${BRANCH_PREFIX}`]);
      if (res.code !== 0) return null;
      return res.out
        .split("\n")
        .filter(Boolean)
        .map((ref) => ref.replace(/^refs\/heads\//, ""));
    },

    remoteBranches(repoPath) {
      const res = sh(["git", "-C", repoPath, "ls-remote", "--heads", "origin", `refs/heads/${BRANCH_PREFIX}*`]);
      if (res.code !== 0) return null;
      return res.out
        .split("\n")
        .map((line) => line.split("\t")[1])
        .filter((ref): ref is string => Boolean(ref))
        .map((ref) => ref.replace("refs/heads/", ""));
    },

    worktrees(stateDir) {
      const root = resolve(stateDir, "worktrees");
      // macOS 的 /var 是指向 /private/var 的符号链接，git 记录真实路径；两边都归一化才能配对
      const canonical = (path: string): string => {
        try {
          return realpathSync(path);
        } catch {
          return resolve(path);
        }
      };
      const canonicalRoot = canonical(root);
      const found = new Map<string, WorktreeEntry>();
      for (const repo of deps.repos) {
        const res = sh(["git", "-C", repo.path, "worktree", "list", "--porcelain"]);
        if (res.code !== 0) continue;
        for (const block of res.out.split(/\n\s*\n/)) {
          const listed = block.split("\n").find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
          if (!listed) continue;
          const path0 = resolve(listed);
          // 目录已被手工删掉时父目录仍在，用它归一化才不会把路径误判到别处
          if (canonical(dirname(path0)) !== canonicalRoot) continue;
          const path = join(root, basename(path0));
          found.set(canonical(path), {
            path,
            repoPath: repo.path,
            locked: block.split("\n").some((line) => line === "locked" || line.startsWith("locked ")),
            stale: !existsSync(path0),
          });
        }
      }
      if (existsSync(root)) {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const path = join(root, entry.name);
          const key = canonical(path);
          if (!found.has(key)) found.set(key, { path, repoPath: null, locked: false, stale: false });
        }
      }
      return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
    },

    openPrs(repoPath) {
      const repo = remoteRepo(repoByPath.get(resolve(repoPath))?.remote ?? remoteUrl(repoPath));
      if (!repo) return null;
      let res: ExecResult;
      try {
        res = deps.runner([
          "gh", "pr", "list",
          "--state", "open",
          "--limit", "200",
          "--json", "number,headRefName,url",
          "--repo", repo,
        ]);
      } catch {
        // gh 不在 PATH 时 spawn 直接抛异常；按「无法确认」处理，不中断扫描
        return null;
      }
      if (res.code !== 0) return null;
      try {
        const rows = JSON.parse(res.out) as Array<{ number?: unknown; headRefName?: unknown; url?: unknown }>;
        return rows
          .filter((r) => typeof r.number === "number" && typeof r.headRefName === "string")
          .map((r) => ({ number: r.number as number, head: r.headRefName as string, url: String(r.url ?? ""), repo }));
      } catch {
        return null;
      }
    },
  };
}

export type ReconcileAction =
  | {
      kind: "remove-worktree";
      label: string;
      workdir: string;
      repoPath: string | null;
      taskId: string | null;
      /** 目录已不存在，只清 git 里的登记 */
      stale?: true;
    }
  | { kind: "delete-local-branch"; label: string; repoPath: string; branch: string; taskId: string | null }
  | { kind: "delete-remote-branch"; label: string; repoPath: string; branch: string; taskId: string | null }
  | { kind: "close-pr"; label: string; repo: string; number: number; taskId: string | null }
  | { kind: "drop-ledger"; label: string; taskId: string; effectKind: EffectKind; target: string };

export interface ReconcilePlan {
  scope: string;
  taskId: string | null;
  actions: ReconcileAction[];
  kept: string[];
  unknown: string[];
}

export interface ReconcileInput {
  tasks: Task[];
  /** 有值时只核对这一个任务；无记录但磁盘有同名资源也会报出来 */
  onlyTaskId?: string;
  repos: RepoConfig[];
  stateDir: string;
  probes: ReconcileProbes;
  effects: (taskId: string) => Effect[];
}

/** 只能清理已结束（非成功）的任务残留与无主资源；运行中任务一律保留 */
function residueLabel(task: Task, action: string): string {
  return `${action}（任务 ${task.id} ${task.status}）`;
}

/**
 * 由任务记录与磁盘/远程/GitHub 实际状态推出差异。只读：不删任何东西。
 * 归属规则：资源名里的任务号指向已有任务时按状态判断；没有任务记录一律视为孤儿。
 */
export function planReconcile(input: ReconcileInput): ReconcilePlan {
  const { tasks, onlyTaskId, repos, stateDir, probes, effects } = input;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const worktrees: ReconcileAction[] = [];
  const local: ReconcileAction[] = [];
  const remote: ReconcileAction[] = [];
  const prs: ReconcileAction[] = [];
  const ledger: ReconcileAction[] = [];
  const kept: string[] = [];
  const unknown: string[] = [];

  // 工作副本先探：locked 表示有人显式保护，该任务的所有资源都不清理
  const wts = probes.worktrees(stateDir);
  const lockedIds = new Set(wts.filter((w) => w.locked).map((w) => basename(w.path)));

  const localSets = new Map<string, Set<string> | null>();
  const remoteSets = new Map<string, Set<string> | null>();

  const inScope = (id: string | null): boolean => !onlyTaskId || id === onlyTaskId;

  for (const repo of repos) {
    const branches = probes.localBranches(repo.path);
    localSets.set(repo.path, branches ? new Set(branches) : null);
    if (!branches) {
      unknown.push(`本地分支：仓库 ${repo.alias} 无法查询（路径不是 git 仓库）`);
    }
    for (const branch of branches ?? []) {
      const id = taskIdOfBranch(branch);
      if (!id || !inScope(id)) continue;
      if (lockedIds.has(id)) {
        kept.push(`本地分支 ${branch}（任务 ${id} 的工作副本已锁定，保留）`);
        continue;
      }
      const task = byId.get(id);
      if (!task) {
        local.push({
          kind: "delete-local-branch",
          label: `删除本地分支 ${branch}（无任务记录）`,
          repoPath: repo.path,
          branch,
          taskId: null,
        });
      } else if (ACTIVE[task.status]) {
        kept.push(`本地分支 ${branch}（任务 ${id} ${task.status}，保留）`);
      } else if (task.status === "succeeded") {
        kept.push(`本地分支 ${branch}（任务 ${id} 成功，保留）`);
      } else {
        local.push({
          kind: "delete-local-branch",
          label: residueLabel(task, `删除本地分支 ${branch}`),
          repoPath: repo.path,
          branch,
          taskId: id,
        });
      }
    }

    const heads = probes.remoteBranches(repo.path);
    remoteSets.set(repo.path, heads ? new Set(heads) : null);
    if (!heads) {
      unknown.push(`远程分支：仓库 ${repo.alias} 无法查询（无 origin 或离线）`);
    } else {
      for (const branch of heads) {
        const id = taskIdOfBranch(branch);
        if (!id || !inScope(id)) continue;
        if (lockedIds.has(id)) {
          kept.push(`远程分支 origin/${branch}（任务 ${id} 的工作副本已锁定，保留）`);
          continue;
        }
        const task = byId.get(id);
        if (!task) {
          remote.push({
            kind: "delete-remote-branch",
            label: `删除远程分支 origin/${branch}（无任务记录）`,
            repoPath: repo.path,
            branch,
            taskId: null,
          });
        } else if (ACTIVE[task.status]) {
          kept.push(`远程分支 origin/${branch}（任务 ${id} ${task.status}，保留）`);
        } else if (task.status === "succeeded") {
          kept.push(`远程分支 origin/${branch}（任务 ${id} 成功，保留）`);
        } else {
          remote.push({
            kind: "delete-remote-branch",
            label: residueLabel(task, `删除远程分支 origin/${branch}`),
            repoPath: repo.path,
            branch,
            taskId: id,
          });
        }
      }
    }

    const open = probes.openPrs(repo.path);
    if (!open) {
      unknown.push(`PR：仓库 ${repo.alias} 无法查询（gh 不可用或非 GitHub）`);
    } else {
      for (const pr of open) {
        const id = taskIdOfBranch(pr.head);
        if (!id || !inScope(id)) continue;
        if (lockedIds.has(id)) {
          kept.push(`PR #${pr.number} ${pr.head}（任务 ${id} 的工作副本已锁定，保留）`);
          continue;
        }
        const task = byId.get(id);
        if (!task) {
          prs.push({
            kind: "close-pr",
            label: `关闭 PR #${pr.number} ${pr.url}（无任务记录）`,
            repo: pr.repo,
            number: pr.number,
            taskId: null,
          });
        } else if (ACTIVE[task.status]) {
          kept.push(`PR #${pr.number} ${pr.head}（任务 ${id} ${task.status}，保留）`);
        } else if (task.status === "succeeded") {
          kept.push(`PR #${pr.number} ${pr.head}（任务 ${id} 成功，保留）`);
        } else {
          prs.push({
            kind: "close-pr",
            label: residueLabel(task, `关闭 PR #${pr.number} ${pr.url}`),
            repo: pr.repo,
            number: pr.number,
            taskId: id,
          });
        }
      }
    }
  }

  for (const wt of wts) {
    const id = basename(wt.path);
    if (!TASK_ID.test(id) || !inScope(id)) continue;
    if (wt.locked) {
      kept.push(`工作副本 ${wt.path}（已锁定，保留）`);
      continue;
    }
    const task = byId.get(id);
    if (task && ACTIVE[task.status]) {
      kept.push(`工作副本 ${wt.path}（任务 ${id} ${task.status}，保留）`);
      continue;
    }
    // 目录已被手工删掉时只剩 git 登记；不 prune 会让同名分支永远删不掉
    if (wt.stale) {
      worktrees.push({
        kind: "remove-worktree",
        label: task
          ? residueLabel(task, `清理工作副本登记 ${wt.path}（目录已不存在）`)
          : `清理工作副本登记 ${wt.path}（目录已不存在，无任务记录）`,
        workdir: wt.path,
        repoPath: wt.repoPath,
        taskId: task?.id ?? null,
        stale: true,
      });
      continue;
    }
    // 成功任务的交付物在分支与 PR 上，工作副本属于必然回收的残留
    if (!task) {
      worktrees.push({
        kind: "remove-worktree",
        label: `移除工作副本 ${wt.path}（无任务记录）`,
        workdir: wt.path,
        repoPath: wt.repoPath,
        taskId: null,
      });
      continue;
    }
    worktrees.push({
      kind: "remove-worktree",
      label: residueLabel(task, `移除工作副本 ${wt.path}`),
      workdir: wt.path,
      repoPath: wt.repoPath,
      taskId: id,
    });
  }

  // 账本核对：资源已经不存在时删掉记录；运行中的任务与锁定任务不做账本清理
  const relevant = onlyTaskId ? ([byId.get(onlyTaskId)].filter(Boolean) as Task[]) : tasks;
  for (const task of relevant) {
    if (ACTIVE[task.status] || lockedIds.has(task.id)) continue;
    const repo = repos.find((r) => r.alias === task.repo);
    const localSet = repo ? localSets.get(repo.path) : null;
    const remoteSet = repo ? remoteSets.get(repo.path) : null;
    for (const effect of effects(task.id)) {
      if (effect.kind === "worktree" && !existsSync(effect.target)) {
        ledger.push({
          kind: "drop-ledger",
          label: `删除账本记录：${task.id} · 工作副本 ${effect.target}（已不存在）`,
          taskId: task.id,
          effectKind: "worktree",
          target: effect.target,
        });
      }
      if (effect.kind === "branch" && localSet && !localSet.has(effect.target)) {
        ledger.push({
          kind: "drop-ledger",
          label: `删除账本记录：${task.id} · 本地分支 ${effect.target}（已不存在）`,
          taskId: task.id,
          effectKind: "branch",
          target: effect.target,
        });
      }
      if (effect.kind === "push" && remoteSet && effect.detail && !remoteSet.has(effect.detail)) {
        ledger.push({
          kind: "drop-ledger",
          label: `删除账本记录：${task.id} · 远程分支 origin/${effect.detail}（已不存在）`,
          taskId: task.id,
          effectKind: "push",
          target: effect.target,
        });
      }
    }
  }

  // 先关 PR 再删远程分支：分支先消失会让 PR 变成无头的半关闭状态
  const actions = [...worktrees, ...prs, ...local, ...remote, ...ledger];
  return {
    scope: onlyTaskId ? `任务 ${onlyTaskId}` : `全部任务（${tasks.length}）`,
    taskId: onlyTaskId ?? null,
    actions,
    kept,
    unknown,
  };
}

export function formatReconcilePlan(plan: ReconcilePlan, trigger: string): string {
  const lines = [`reconcile · ${plan.scope}`, `可清理：${plan.actions.length} 项`];
  if (plan.actions.length > 0) {
    lines.push("");
    plan.actions.forEach((a, i) => lines.push(`${i + 1}. ${a.label}`));
    const target = plan.taskId ? ` ${plan.taskId}` : "";
    lines.push("", `确认清理：${trigger} reconcile${target} --fix`);
  } else {
    lines.push("", "没有可清理的残留。");
  }
  if (plan.kept.length > 0) lines.push("", "保留", ...plan.kept.map((s) => `- ${s}`));
  if (plan.unknown.length > 0) lines.push("", "无法确认", ...plan.unknown.map((s) => `- ${s}`));
  return lines.join("\n");
}

export interface ReconcileOutcome {
  label: string;
  ok: boolean;
  error?: string;
}

export interface ReconcileDeps {
  runner: Runner;
  store: Store;
}

/** 逐项执行，失败不中断后续：成功的资源不再出现在下一次核对里 */
export function applyReconcile(plan: ReconcilePlan, deps: ReconcileDeps): ReconcileOutcome[] {
  return plan.actions.map((a) => {
    try {
      return { label: a.label, ...runAction(a, deps) };
    } catch (e) {
      return { label: a.label, ok: false, error: String(e).slice(0, 300) };
    }
  });
}

/** 工作副本是否仍在 git 登记里；目录可能已被删，按路径末段比对 */
function registered(repoPath: string, workdir: string): boolean {
  const res = sh(["git", "-C", repoPath, "worktree", "list", "--porcelain"]);
  if (res.code !== 0) return true;
  const name = basename(workdir);
  return res.out
    .split("\n")
    .some((line) => line.startsWith("worktree ") && basename(line.slice("worktree ".length)) === name);
}

function runAction(a: ReconcileAction, deps: ReconcileDeps): { ok: boolean; error?: string } {
  switch (a.kind) {
    case "remove-worktree": {
      if (a.stale) {
        if (!a.repoPath) return { ok: false, error: "工作副本未登记到任何仓库，无法清理登记" };
        const pruned = sh(["git", "-C", a.repoPath, "worktree", "prune"]);
        if (pruned.code !== 0) return { ok: false, error: (pruned.err || pruned.out).slice(0, 300) };
        if (registered(a.repoPath, a.workdir)) return { ok: false, error: "工作副本登记仍然存在" };
        return { ok: true };
      }
      if (a.repoPath) {
        // 只交给 git 删：locked 的工作副本 git 会拒绝，兜底强删会毁掉受保护的内容
        const res = removeWorktree(a.repoPath, a.workdir);
        if (res.code !== 0) return { ok: false, error: (res.err || res.out).slice(0, 300) };
      } else {
        // 未登记的目录没有 git 语义，只能直接删
        rmSync(a.workdir, { recursive: true, force: true });
      }
      if (existsSync(a.workdir)) return { ok: false, error: "工作副本仍然存在" };
      if (a.taskId) deps.store.removeEffect(a.taskId, "worktree", a.workdir);
      return { ok: true };
    }
    case "delete-local-branch": {
      deleteBranch(a.repoPath, a.branch);
      const gone = sh(["git", "-C", a.repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${a.branch}`]).code !== 0;
      if (!gone) return { ok: false, error: `分支 ${a.branch} 仍存在` };
      if (a.taskId) deps.store.removeEffect(a.taskId, "branch", a.branch);
      return { ok: true };
    }
    case "delete-remote-branch": {
      const res = sh(["git", "-C", a.repoPath, "push", "origin", "--delete", a.branch]);
      if (res.code !== 0) return { ok: false, error: (res.err || res.out).slice(0, 300) };
      if (a.taskId) {
        for (const effect of deps.store.effectsOf(a.taskId)) {
          if (effect.kind === "push" && effect.detail === a.branch) {
            deps.store.removeEffect(a.taskId, "push", effect.target);
          }
        }
      }
      return { ok: true };
    }
    case "close-pr": {
      const res = closePr(deps.runner, a.repo, a.number);
      if (!res.ok) return { ok: false, error: res.error.slice(0, 300) };
      if (a.taskId) deps.store.removeEffect(a.taskId, "pr", String(a.number));
      return { ok: true };
    }
    case "drop-ledger": {
      deps.store.removeEffect(a.taskId, a.effectKind, a.target);
      return { ok: true };
    }
  }
}

export function formatReconcileResult(plan: ReconcilePlan, results: ReconcileOutcome[]): string {
  const done = results.filter((r) => r.ok).length;
  const lines = [
    `reconcile · ${plan.scope}`,
    results.length === 0 ? "没有可清理的残留。" : `已清理：${done}/${results.length}`,
  ];
  for (const r of results) {
    lines.push(r.ok ? `✓ ${r.label}` : `✗ ${r.label}：${r.error ?? "未知错误"}`);
  }
  if (plan.kept.length > 0) lines.push("", "保留", ...plan.kept.map((s) => `- ${s}`));
  if (plan.unknown.length > 0) lines.push("", "无法确认", ...plan.unknown.map((s) => `- ${s}`));
  if (done < results.length) lines.push("", "部分失败，修正后重发 --fix。");
  return lines.join("\n");
}
