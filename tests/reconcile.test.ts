import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyReconcile,
  formatReconcilePlan,
  planReconcile,
  type ReconcileContext,
  type ReconcileItem,
  type ReconcileProbes,
} from "../src/reconcile";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { parseCommand, type Config } from "../src/config";
import type { EffectKind, IncomingMessage, Task } from "../src/types";
import type { Runner } from "../src/github";
import { sh } from "../src/git";

const REPO = { alias: "demo", path: "/repo" };
const STATE = "/state";
const NOW = 1_000_000;

function task(over: Partial<Task> & { id: string }): Task {
  const { id, ...rest } = over;
  return {
    id,
    source: `seed:${id}`,
    channel: "fake",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "做点事",
    status: "queued",
    branch: null,
    prUrl: null,
    sessionId: null,
    baseRef: null,
    context: null,
    replyPr: null,
    replyIssue: null,
    replyRepo: null,
    summary: null,
    error: null,
    createdAt: 0,
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
    ...rest,
  };
}

interface World {
  local: string[];
  /** null 表示查询不到 origin */
  remote: string[] | null;
  worktrees: string[];
  open: Array<{ branch: string; url: string }> | null;
}

function world(over: Partial<World> = {}): World {
  return { local: [], remote: [], worktrees: [], open: [], ...over };
}

function ctx(w: World, stateDir = STATE): ReconcileContext {
  const probes: ReconcileProbes = {
    branches: () => ({ local: w.local, remote: w.remote }),
    worktrees: () => w.worktrees,
    openPrs: () => w.open,
  };
  return { stateDir, repos: [REPO], probes, now: NOW };
}

function actions(items: ReconcileItem[]): string[] {
  return items.map((i) => `${i.action}:${i.target}`).sort();
}

describe("reconcile 命令解析", () => {
  test("/pisa reconcile 是命令而不是任务", () => {
    expect(parseCommand("/pisa reconcile", "/pisa")).toEqual({ kind: "reconcile", body: "" });
    expect(parseCommand("/pisa reconcile t_1 --fix", "/pisa")).toEqual({ kind: "reconcile", body: "t_1 --fix" });
  });
});

describe("planReconcile", () => {
  test("已结束任务的本地分支、远程分支、工作副本与 PR 都可清理", () => {
    const workdir = resolve(STATE, "worktrees", "t_1");
    const plan = planReconcile(
      [task({ id: "t_1", status: "failed", branch: "pisa/t_1" })],
      null,
      ctx(
        world({
          local: ["pisa/t_1"],
          remote: ["pisa/t_1"],
          worktrees: [workdir],
          open: [{ branch: "pisa/t_1", url: "https://github.com/o/r/pull/7" }],
        }),
      ),
    );

    expect(actions(plan.items)).toEqual([
      `close-pr:https://github.com/o/r/pull/7`,
      `delete-branch:pisa/t_1`,
      `delete-remote-branch:pisa/t_1`,
      `remove-worktree:${workdir}`,
    ]);
    expect(plan.items.every((i) => i.fixable)).toBe(true);
    expect(plan.items.map((i) => i.action)).toEqual([
      "remove-worktree",
      "delete-branch",
      "close-pr",
      "delete-remote-branch",
    ]);
    expect(formatReconcilePlan(plan, "/pisa")).toContain("执行清理：/pisa reconcile --fix");
  });

  test("成功的任务保留分支与 PR，等待 merge 或 rewind", () => {
    const plan = planReconcile(
      [
        task({
          id: "t_2",
          status: "succeeded",
          branch: "pisa/t_2",
          prUrl: "https://github.com/o/r/pull/8",
          endedAt: 1,
        }),
      ],
      null,
      ctx(
        world({
          local: ["pisa/t_2"],
          remote: ["pisa/t_2"],
          open: [{ branch: "pisa/t_2", url: "https://github.com/o/r/pull/8" }],
        }),
      ),
    );

    expect(plan.items).toEqual([]);
    expect(plan.retained.join("\n")).toContain("等待合并");
    expect(plan.retained.join("\n")).toContain("等待合并或 rewind");
  });

  test("运行中的任务不清理；暂停但缺工作副本只报告", () => {
    const plan = planReconcile(
      [
        task({ id: "t_run", status: "running", branch: "pisa/t_run", startedAt: NOW }),
        task({ id: "t_pause", status: "paused", branch: "pisa/t_pause" }),
      ],
      null,
      ctx(world({ local: ["pisa/t_run", "pisa/t_pause"] })),
    );

    expect(plan.items).toEqual([
      {
        action: "remove-worktree",
        taskId: "t_pause",
        status: "paused",
        repo: "demo",
        target: resolve(STATE, "worktrees", "t_pause"),
        fixable: false,
        note: "工作副本缺失，恢复前需要重新创建",
      },
    ]);
    expect(plan.retained.join("\n")).toContain("任务依赖");
  });

  test("共用分支与仍被其它任务使用的分支不删", () => {
    const shared = planReconcile(
      [task({ id: "t_child", status: "failed", branch: "pisa/t_parent" })],
      null,
      ctx(world({ local: ["pisa/t_parent"], remote: ["pisa/t_parent"] })),
    );
    expect(shared.items).toEqual([]);
    expect(shared.retained.join("\n")).toContain("非本任务自建");

    const followed = planReconcile(
      [
        task({ id: "t_1", status: "failed", branch: "pisa/t_1", endedAt: 1 }),
        task({ id: "t_2", status: "succeeded", branch: "pisa/t_1" }),
      ],
      null,
      ctx(world({ local: ["pisa/t_1"], remote: ["pisa/t_1"] })),
    );
    expect(followed.items).toEqual([]);
    expect(followed.retained.join("\n")).toContain("仍被未结束或已完成的任务使用");
  });

  test("共用分支上的 PR 属于父任务，不关闭", () => {
    const url = "https://github.com/o/r/pull/5";
    const plan = planReconcile(
      [task({ id: "t_child", status: "failed", branch: "pisa/t_parent", prUrl: url })],
      null,
      ctx(
        world({
          local: ["pisa/t_parent"],
          remote: ["pisa/t_parent"],
          open: [{ branch: "pisa/t_parent", url }],
        }),
      ),
    );

    expect(plan.items).toEqual([]);
    expect(plan.retained.join("\n")).toContain("分支不属于该任务");
  });

  test("查不到 origin 时不判断远程分支", () => {
    const plan = planReconcile(
      [task({ id: "t_1", status: "failed", branch: "pisa/t_1" })],
      null,
      ctx(world({ local: ["pisa/t_1"], remote: null })),
    );

    expect(actions(plan.items)).toEqual(["delete-branch:pisa/t_1"]);
    expect(plan.notes.join("\n")).toContain("远程分支未核对");
    expect(planReconcile([], null, ctx(world({ remote: null }))).items).toEqual([]);
  });

  test("任务表里没有记录的分支、工作副本与 PR 视为孤儿", () => {
    const workdir = resolve(STATE, "worktrees", "t_gone");
    const plan = planReconcile(
      [],
      null,
      ctx(
        world({
          local: ["main", "pisa/t_gone"],
          remote: ["pisa/t_gone"],
          worktrees: [workdir],
          open: [{ branch: "pisa/t_gone", url: "https://github.com/o/r/pull/9" }],
        }),
      ),
    );

    expect(actions(plan.items)).toEqual([
      "close-pr:https://github.com/o/r/pull/9",
      "delete-branch:pisa/t_gone",
      "delete-remote-branch:pisa/t_gone",
      `remove-worktree:${workdir}`,
    ]);
    expect(plan.items.every((i) => i.taskId === null && i.fixable)).toBe(true);
  });

  test("指定任务号只核对该任务，不扫描孤儿", () => {
    const plan = planReconcile(
      [
        task({ id: "t_1", status: "failed", branch: "pisa/t_1" }),
        task({ id: "t_2", status: "failed", branch: "pisa/t_2" }),
      ],
      "t_2",
      ctx(world({ local: ["pisa/t_1", "pisa/t_gone"], remote: ["pisa/t_2"] })),
    );

    expect(plan.taskId).toBe("t_2");
    expect(plan.scanned).toBe(1);
    expect(actions(plan.items)).toEqual(["delete-remote-branch:pisa/t_2"]);
    expect(actions(plan.items)).not.toContain("delete-branch:pisa/t_gone");
  });

  test("gh 不可用时跳过 PR 核对并说明", () => {
    const plan = planReconcile(
      [task({ id: "t_1", status: "failed", branch: "pisa/t_1" })],
      null,
      ctx(world({ local: ["pisa/t_1"], open: null })),
    );
    expect(plan.notes.join("\n")).toContain("PR 未核对");
    expect(actions(plan.items)).toEqual(["delete-branch:pisa/t_1"]);
  });
});

describe("applyReconcile", () => {
  let repo: string;
  let stateDir: string;

  function git(...args: string[]): string {
    return sh(["git", "-C", repo, ...args]).out;
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pisa-reconcile-repo-"));
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    stateDir = mkdtempSync(join(tmpdir(), "pisa-reconcile-state-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("按计划删工作副本与本地分支、关 PR，并清对应账本", () => {
    git("branch", "pisa/t_1");
    const workdir = join(stateDir, "worktrees", "t_1");
    expect(sh(["git", "-C", repo, "worktree", "add", "-q", workdir, "pisa/t_1"]).code).toBe(0);
    const plan = planReconcile([task({ id: "t_1", status: "cancelled", branch: "pisa/t_1" })], null, {
      stateDir,
      repos: [{ alias: "demo", path: repo }],
      probes: {
        branches: () => ({
          local: sh(["git", "-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads"]).out
            .split("\n")
            .filter((b) => b && b !== "main"),
          remote: [],
        }),
        worktrees: () =>
          sh(["git", "-C", repo, "worktree", "list", "--porcelain"])
            .out.split("\n")
            .filter((l) => l.startsWith("worktree "))
            .map((l) => l.slice("worktree ".length)),
        openPrs: () => [{ branch: "pisa/t_1", url: "https://github.com/o/r/pull/7" }],
      },
      now: NOW,
    });

    const calls: string[][] = [];
    const forgotten: string[] = [];
    const runner: Runner = (args) => {
      calls.push(args);
      return { code: 0, out: "", err: "" };
    };
    const results = applyReconcile(plan, {
      stateDir,
      repoPath: (alias) => (alias === "demo" ? repo : null),
      runner,
      forget: (id, kind: EffectKind, target) => forgotten.push(`${id}:${kind}:${target}`),
    });

    expect(results.every((r) => r.ok)).toBe(true);
    expect(existsSync(workdir)).toBe(false);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/pisa/t_1"]).code).not.toBe(0);
    expect(calls).toEqual([["gh", "pr", "close", "7", "--repo", "o/r"]]);
    expect(forgotten.sort()).toEqual(["t_1:branch:pisa/t_1", "t_1:pr:7", `t_1:worktree:${workdir}`]);
  });
});

class FakeChannel {
  name = "fake";
  sent: string[] = [];
  async start(): Promise<void> {}
  private seq = 0;
  async send(_chatId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push(text);
    this.seq += 1;
    return { messageId: String(this.seq) };
  }
  async stop(): Promise<void> {}
  get last(): string {
    return this.sent[this.sent.length - 1] ?? "";
  }
}

describe("Router.reconcile", () => {
  let repo: string;
  let origin: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;
  let prs: Array<{ branch: string; url: string }>;
  let ghCalls: string[][];

  function git(...args: string[]): string {
    return sh(["git", "-C", repo, ...args]).out;
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pisa-reconcile-router-"));
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    origin = mkdtempSync(join(tmpdir(), "pisa-reconcile-origin-"));
    sh(["git", "init", "-q", "--bare", origin]);
    git("remote", "add", "origin", origin);
    stateDir = mkdtempSync(join(tmpdir(), "pisa-reconcile-router-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
    prs = [];
    ghCalls = [];
    cfg = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: ["u1"], repos: ["demo"] },
      repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: true, pr: true, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      stateDir,
    };
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function build(): Router {
    const runner: Runner = (args) => {
      ghCalls.push(args);
      if (args[2] === "list") {
        return {
          code: 0,
          out: JSON.stringify(prs.map((p) => ({ url: p.url, headRefName: p.branch }))),
          err: "",
        };
      }
      if (args[2] === "close") {
        prs = prs.filter((p) => !p.url.endsWith(`/${args[3]}`));
        return { code: 0, out: "", err: "" };
      }
      return { code: 0, out: "", err: "" };
    };
    return new Router({
      cfg,
      store,
      worker: { async run() { return { ok: true, summary: "", exitCode: 0 }; } },
      deliverer: new GitDeliverer(cfg),
      channel,
      ghRunner: runner,
      now: () => NOW,
    });
  }

  function seed(over: Partial<Task> & { id: string }): Task {
    const t = task({ repo: "demo", ...over });
    store.insertTask(t);
    return t;
  }

  /** 建分支、工作副本并推到 origin */
  function seedBranchAndWorktree(id: string): string {
    git("branch", `pisa/${id}`);
    sh(["git", "-C", repo, "push", "-q", "origin", `pisa/${id}`]);
    const workdir = join(stateDir, "worktrees", id);
    expect(sh(["git", "-C", repo, "worktree", "add", "-q", workdir, `pisa/${id}`]).code).toBe(0);
    return workdir;
  }

  function msg(text: string): IncomingMessage {
    return {
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      channel: "fake",
      chatId: "c1",
      userId: "u1",
      text,
    };
  }

  test("--fix 清理已结束任务，保留运行中的任务", async () => {
    const doneDir = seedBranchAndWorktree("t_done");
    const liveDir = seedBranchAndWorktree("t_live");
    const done = seed({
      id: "t_done",
      status: "failed",
      branch: "pisa/t_done",
      prUrl: "https://github.com/o/r/pull/7",
      endedAt: NOW,
    });
    seed({ id: "t_live", status: "running", branch: "pisa/t_live", startedAt: NOW });
    prs = [{ branch: "pisa/t_done", url: "https://github.com/o/r/pull/7" }];
    for (const [kind, target] of [
      ["worktree", doneDir],
      ["branch", "pisa/t_done"],
      ["push", "origin"],
      ["pr", "7"],
    ] as Array<[EffectKind, string]>) {
      store.effect(done.id, kind, target);
    }

    await build().handle(msg("/pisa reconcile --fix"));

    expect(existsSync(doneDir)).toBe(false);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/pisa/t_done"]).code).not.toBe(0);
    expect(sh(["git", "--git-dir", origin, "rev-parse", "--verify", "--quiet", "refs/heads/pisa/t_done"]).code).not.toBe(0);
    expect(existsSync(liveDir)).toBe(true);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/pisa/t_live"]).code).toBe(0);
    expect(sh(["git", "--git-dir", origin, "rev-parse", "--verify", "--quiet", "refs/heads/pisa/t_live"]).code).toBe(0);
    expect(ghCalls.some((a) => a[2] === "close" && a[3] === "7")).toBe(true);
    expect(store.effectsOf("t_done")).toEqual([]);
    expect(channel.last).toContain("已清理 · 4/4");
    expect(channel.last).toContain("✓ 删除本地分支 pisa/t_done");
    expect(channel.last).toContain("✓ 删除远程分支 pisa/t_done");
    expect(channel.last).toContain("✓ 关闭 PR https://github.com/o/r/pull/7");
  });

  test("预览只报告差异，指定任务号时只看该任务", async () => {
    const doneDir = seedBranchAndWorktree("t_done");
    seedBranchAndWorktree("t_other");
    seed({ id: "t_done", status: "cancelled", branch: "pisa/t_done", endedAt: NOW });
    seed({ id: "t_other", status: "failed", branch: "pisa/t_other", endedAt: NOW });

    await build().handle(msg("/pisa reconcile t_done"));

    expect(channel.last).toContain("reconcile · 任务 t_done");
    expect(channel.last).toContain("可清理");
    expect(channel.last).toContain(`工作副本 ${doneDir}`);
    expect(channel.last).not.toContain("t_other");
    expect(channel.last).toContain("执行清理：/pisa reconcile t_done --fix");
    expect(existsSync(doneDir)).toBe(true);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/pisa/t_done"]).code).toBe(0);
  });
});
