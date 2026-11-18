import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { parseCommand, type Config } from "../src/config";
import { formatReconcile, planReconcile, type ReconcileInput } from "../src/reconcile";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "../src/types";
import type { Runner } from "../src/github";
import type { WorkerRunner } from "../src/worker";
import { sh } from "../src/git";

class FakeChannel implements ChannelAdapter {
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

function git(dir: string, ...args: string[]): string {
  return sh(["git", "-C", dir, ...args]).out;
}

function commitFile(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), body);
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `add ${name}`);
}

function task(over: Partial<Task> & { id: string }): Task {
  const base: Task = {
    id: over.id,
    source: `seed:${over.id}`,
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
  };
  return { ...base, ...over };
}

function baseInput(tasks: Task[], over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    tasks,
    worktreeRoot: "/state/worktrees",
    repos: [
      {
        alias: "demo",
        repoPath: "/repos/demo",
        slug: "o/r",
        baseBranch: "main",
        localBranches: ["main"],
        remoteBranches: ["main"],
        openPrs: [],
      },
    ],
    worktrees: [],
    ...over,
  };
}

describe("planReconcile", () => {
  test("已结束任务的残留可清理，运行中与成功待合并的保留", () => {
    const failed = task({ id: "t_1", status: "failed", branch: "pisa/t_1" });
    const running = task({ id: "t_2", status: "running", branch: "pisa/t_2" });
    const done = task({ id: "t_3", status: "succeeded", branch: "pisa/t_3" });
    const input = baseInput([failed, running, done], {
      repos: [
        {
          alias: "demo",
          repoPath: "/repos/demo",
          slug: "o/r",
          baseBranch: "main",
          localBranches: ["main", "pisa/t_1", "pisa/t_2", "pisa/t_3"],
          remoteBranches: ["main", "pisa/t_1"],
          openPrs: [{ number: 7, head: "pisa/t_1" }],
        },
      ],
      worktrees: [
        { path: "/state/worktrees/t_1", repo: "demo", repoPath: "/repos/demo", branch: "pisa/t_1" },
        { path: "/state/worktrees/t_2", repo: "demo", repoPath: "/repos/demo", branch: "pisa/t_2" },
        { path: "/state/worktrees/t_3", repo: "demo", repoPath: "/repos/demo", branch: "pisa/t_3" },
      ],
    });

    const findings = planReconcile(input);
    const of = (kind: string, target: string) => findings.find((f) => f.kind === kind && f.target === target);

    expect(of("worktree", "/state/worktrees/t_1")?.disposition).toBe("fixable");
    expect(of("worktree", "/state/worktrees/t_2")?.disposition).toBe("keep");
    expect(of("worktree", "/state/worktrees/t_3")?.disposition).toBe("keep");
    expect(of("local-branch", "pisa/t_1")?.disposition).toBe("fixable");
    expect(of("local-branch", "pisa/t_2")?.disposition).toBe("keep");
    expect(of("local-branch", "pisa/t_3")?.disposition).toBe("keep");
    expect(of("remote-branch", "pisa/t_1")?.action).toEqual({
      kind: "delete-remote-branch",
      repoPath: "/repos/demo",
      branch: "pisa/t_1",
    });
    expect(of("pr", "7")?.action).toEqual({ kind: "close-pr", repo: "o/r", number: 7 });
    // 主干不参与对账
    expect(findings.some((f) => f.target === "main")).toBe(false);
  });

  test("没有任务记录的资源按孤儿清理，非 pisa 分支不动", () => {
    const input = baseInput([], {
      repos: [
        {
          alias: "demo",
          repoPath: "/repos/demo",
          slug: "o/r",
          baseBranch: "main",
          localBranches: ["main", "pisa/t_9", "hotfix/hand"],
          remoteBranches: ["origin-only"],
          openPrs: [{ number: 3, head: "pisa/t_9" }],
        },
      ],
      worktrees: [{ path: "/state/worktrees/t_9", repo: null, repoPath: null, branch: null }],
    });

    const findings = planReconcile(input);
    expect(findings.find((f) => f.kind === "worktree")?.disposition).toBe("fixable");
    expect(findings.find((f) => f.kind === "worktree")?.note).toContain("没有任务记录");
    expect(findings.find((f) => f.kind === "worktree")?.action).toEqual({
      kind: "remove-worktree",
      repoPath: null,
      path: "/state/worktrees/t_9",
    });
    expect(findings.find((f) => f.kind === "local-branch")?.taskIds).toEqual(["t_9"]);
    expect(findings.some((f) => f.target === "hotfix/hand")).toBe(false);
    expect(findings.some((f) => f.target === "origin-only")).toBe(false);
    expect(findings.find((f) => f.kind === "pr")?.disposition).toBe("fixable");
  });

  test("scope 只留该任务的资源", () => {
    const a = task({ id: "t_1", status: "failed", branch: "pisa/t_1" });
    const b = task({ id: "t_2", status: "failed", branch: "pisa/t_2" });
    const findings = planReconcile(
      baseInput([a, b], {
        repos: [
          {
            alias: "demo",
            repoPath: "/repos/demo",
            slug: null,
            baseBranch: "main",
            localBranches: ["pisa/t_1", "pisa/t_2"],
            remoteBranches: [],
            openPrs: null,
          },
        ],
        scope: "t_2",
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.target).toBe("pisa/t_2");
  });

  test("查不到 PR 时记为无法确认，不给动作", () => {
    const t = task({ id: "t_1", status: "failed", branch: "pisa/t_1", prUrl: "https://github.com/o/r/pull/5" });
    const findings = planReconcile(
      baseInput([t], {
        repos: [
          {
            alias: "demo",
            repoPath: "/repos/demo",
            slug: "o/r",
            baseBranch: "main",
            localBranches: ["pisa/t_1"],
            remoteBranches: [],
            openPrs: null,
          },
        ],
      }),
    );
    const pr = findings.find((f) => f.kind === "pr");
    expect(pr?.disposition).toBe("unknown");
    expect(pr?.action).toBeNull();
  });

  test("运行中任务的工作副本不见了记为缺失", () => {
    const t = task({ id: "t_1", status: "running", branch: "pisa/t_1" });
    const findings = planReconcile(baseInput([t]));
    const missing = findings.find((f) => f.disposition === "missing");
    expect(missing?.kind).toBe("worktree");
    expect(missing?.target).toBe("/state/worktrees/t_1");
    expect(missing?.action).toBeNull();
  });

  test("登记残留（目录已删）按缺失与可清理处理，不再装作工作副本还在", () => {
    const running = task({ id: "t_1", status: "running", branch: "pisa/t_1" });
    const failed = task({ id: "t_2", status: "failed", branch: "pisa/t_2" });
    const findings = planReconcile(
      baseInput([running, failed], {
        worktrees: [
          { path: "/state/worktrees/t_1", repo: "demo", repoPath: "/repos/demo", branch: "pisa/t_1", present: false },
          { path: "/state/worktrees/t_2", repo: "demo", repoPath: "/repos/demo", branch: "pisa/t_2", present: false },
        ],
      }),
    );
    const worktrees = findings.filter((f) => f.kind === "worktree");
    // 运行中的不保留：登记不能当作目录还在，缺失由反向差集报出
    expect(worktrees.some((f) => f.taskIds[0] === "t_1" && f.disposition === "keep")).toBe(false);
    expect(worktrees.find((f) => f.taskIds[0] === "t_1")?.disposition).toBe("missing");
    const stale = worktrees.find((f) => f.taskIds[0] === "t_2");
    expect(stale?.disposition).toBe("fixable");
    expect(stale?.note).toContain("登记残留");
    expect(stale?.action).toEqual({ kind: "remove-worktree", repoPath: "/repos/demo", path: "/state/worktrees/t_2" });
  });

  test("预览文本给出差异与 --fix 提示", () => {
    const t = task({ id: "t_1", status: "cancelled", branch: "pisa/t_1" });
    const input = baseInput([t], {
      repos: [
        {
          alias: "demo",
          repoPath: "/repos/demo",
          slug: "o/r",
          baseBranch: "main",
          localBranches: ["main", "pisa/t_1"],
          remoteBranches: [],
          openPrs: [],
        },
      ],
    });
    const text = formatReconcile(
      { scope: null, scopeRecorded: false, findings: planReconcile(input), outcomes: null, tasks: 1, repos: 1 },
      "/pisa",
    );
    expect(text).toContain("可清理 1");
    expect(text).toContain("[demo] pisa/t_1");
    expect(text).toContain("/pisa reconcile --fix");
  });
});

describe("Router.reconcile", () => {
  const FAILED = "t_20261118_aaaaaa";
  const RUNNING = "t_20261118_bbbbbb";
  const DONE = "t_20261118_cccccc";
  const ORPHAN = "t_20200101_abcdef";

  let repo: string;
  let bare: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;

  function okWorker(): WorkerRunner {
    return {
      async run(_task, workdir): Promise<WorkerResult> {
        writeFileSync(join(workdir, "out.txt"), "hi\n");
        return { ok: true, summary: "改了 out.txt", exitCode: 0 };
      },
    };
  }

  function seedTask(over: Partial<Task> & { id: string }): Task {
    const t = task(over);
    store.insertTask(t);
    return t;
  }

  function worktree(id: string): string {
    return join(stateDir, "worktrees", id);
  }

  function build(prs: Array<{ number: number; head: string }>, closeOk = true) {
    const calls: string[][] = [];
    const runner: Runner = (args) => {
      calls.push(args);
      if (args[1] === "pr" && args[2] === "list") {
        return {
          code: 0,
          out: JSON.stringify(prs.map((p) => ({ number: p.number, headRefName: p.head }))),
          err: "",
        };
      }
      if (args[1] === "pr" && args[2] === "close") {
        return closeOk ? { code: 0, out: "", err: "" } : { code: 1, out: "", err: "gh: close refused" };
      }
      return { code: 0, out: "", err: "" };
    };
    const router = new Router({
      cfg,
      store,
      worker: okWorker(),
      deliverer: new GitDeliverer(cfg),
      channel,
      ghRunner: runner,
    });
    return { router, calls };
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pisa-rec-repo-"));
    bare = mkdtempSync(join(tmpdir(), "pisa-rec-bare-"));
    stateDir = mkdtempSync(join(tmpdir(), "pisa-rec-state-"));
    git(repo, "init", "-q", "-b", "main");
    commitFile(repo, "README.md", "hello\n");
    sh(["git", "init", "-q", "--bare", bare]);
    // origin 显示成 GitHub（slug 用来查 PR），实际推送走本地裸仓库
    git(repo, "remote", "add", "origin", "git@github.com:o/r.git");
    git(repo, "config", "remote.origin.pushurl", bare);
    git(repo, "push", "-q", "origin", "main");

    store = new Store(":memory:");
    channel = new FakeChannel();
    cfg = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: ["u1"], repos: ["demo"] },
      repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      stateDir,
    };
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** 失败任务：本地分支 + 工作副本 + 远端分支 + PR；另有运行中、成功任务各一条分支 */
  function seedRealities(): void {
    git(repo, "branch", `pisa/${FAILED}`);
    git(repo, "branch", `pisa/${RUNNING}`);
    git(repo, "branch", `pisa/${DONE}`);
    git(repo, "push", "-q", "origin", `pisa/${FAILED}`);
    expect(sh(["git", "-C", repo, "worktree", "add", "-q", worktree(FAILED), `pisa/${FAILED}`]).code).toBe(0);
    expect(sh(["git", "-C", repo, "worktree", "add", "-q", worktree(RUNNING), `pisa/${RUNNING}`]).code).toBe(0);

    seedTask({ id: FAILED, status: "failed", branch: `pisa/${FAILED}`, prUrl: "https://github.com/o/r/pull/12" });
    store.effect(FAILED, "worktree", worktree(FAILED));
    store.effect(FAILED, "branch", `pisa/${FAILED}`);
    store.effect(FAILED, "push", "origin", `pisa/${FAILED}`);
    store.effect(FAILED, "pr", "12", "https://github.com/o/r/pull/12");

    seedTask({ id: RUNNING, status: "running", branch: `pisa/${RUNNING}` });
    store.effect(RUNNING, "branch", `pisa/${RUNNING}`);

    seedTask({ id: DONE, status: "succeeded", branch: `pisa/${DONE}` });

    // git 没登记的残留目录（手工删过 worktree 又留下目录）
    mkdirSync(worktree(ORPHAN), { recursive: true });
    writeFileSync(join(worktree(ORPHAN), "leftover.txt"), "x\n");
  }

  test("/pisa reconcile 只预览，不动资源", async () => {
    seedRealities();
    const { router } = build([{ number: 12, head: `pisa/${FAILED}` }]);
    await router.handle(msg("/pisa reconcile"));

    const text = channel.last;
    expect(text).toContain("reconcile · 全部任务");
    expect(text).toContain(`[demo] origin/pisa/${FAILED}`);
    expect(text).toContain(`[demo] PR #12`);
    expect(text).toContain(`- [demo] pisa/${RUNNING}`);
    expect(text).toContain("/pisa reconcile --fix");

    expect(existsSync(worktree(FAILED))).toBe(true);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", `refs/heads/pisa/${FAILED}`]).code).toBe(0);
    expect(sh(["git", "-C", bare, "rev-parse", "--verify", `refs/heads/pisa/${FAILED}`]).code).toBe(0);
  });

  test("/pisa reconcile --fix 清已结束任务的残留，保留其它", async () => {
    seedRealities();
    const { router, calls } = build([{ number: 12, head: `pisa/${FAILED}` }]);
    await router.handle(msg("/pisa reconcile --fix"));

    expect(channel.last).toContain("清理完成。");
    // 失败任务的资源全没了
    expect(existsSync(worktree(FAILED))).toBe(false);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/pisa/${FAILED}`]).code).not.toBe(0);
    expect(sh(["git", "-C", bare, "rev-parse", "--verify", "--quiet", `refs/heads/pisa/${FAILED}`]).code).not.toBe(0);
    expect(calls.some((c) => c[2] === "close" && c[3] === "12")).toBe(true);

    // 运行中与成功待合并的保留
    expect(existsSync(worktree(RUNNING))).toBe(true);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/pisa/${RUNNING}`]).code).toBe(0);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/pisa/${DONE}`]).code).toBe(0);

    // 无任务记录的残留目录被清掉
    expect(existsSync(worktree(ORPHAN))).toBe(false);
  });

  test("/pisa reconcile <任务号> 只查一个任务", async () => {
    seedRealities();
    const { router } = build([{ number: 12, head: `pisa/${FAILED}` }]);
    await router.handle(msg(`/pisa reconcile ${RUNNING}`));

    const text = channel.last;
    expect(text).toContain(`reconcile · ${RUNNING}`);
    expect(text).toContain(`pisa/${RUNNING}`);
    expect(text).not.toContain(`pisa/${FAILED}`);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", `refs/heads/pisa/${FAILED}`]).code).toBe(0);
  });

  test("清理失败时报告错误并保留资源", async () => {
    seedRealities();
    const { router } = build([{ number: 12, head: `pisa/${FAILED}` }], false);
    await router.handle(msg("/pisa reconcile --fix"));

    expect(channel.last).toContain("1 项失败");
    expect(channel.last).toContain("gh: close refused");
    expect(channel.last).toContain("修正后重试");
  });

  test("工作副本被手工删掉：运行中任务报缺失，--fix 不动它的分支", async () => {
    seedRealities();
    rmSync(worktree(RUNNING), { recursive: true, force: true });
    // 目录没了，git 仍登记着这个工作副本
    expect(sh(["git", "-C", repo, "worktree", "list", "--porcelain"]).out).toContain(worktree(RUNNING));

    const { router } = build([{ number: 12, head: `pisa/${FAILED}` }]);
    await router.handle(msg(`/pisa reconcile ${RUNNING}`));
    expect(channel.last).toContain("缺失（1）");
    expect(channel.last).toContain("需要工作副本，但目录不存在");

    await router.handle(msg(`/pisa reconcile ${RUNNING} --fix`));
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/pisa/${RUNNING}`]).code).toBe(0);
  });

  test("--fix 先 prune 登记残留，再删本地分支", async () => {
    seedRealities();
    rmSync(worktree(FAILED), { recursive: true, force: true });
    const { router } = build([{ number: 12, head: `pisa/${FAILED}` }]);
    await router.handle(msg("/pisa reconcile --fix"));

    expect(channel.last).toContain("清理完成。");
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/pisa/${FAILED}`]).code).not.toBe(0);
  });
});

function msg(text: string): IncomingMessage {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    channel: "fake",
    chatId: "c1",
    userId: "u1",
    text,
  };
}

describe("reconcile 命令解析", () => {
  test("/pisa reconcile 是命令而不是任务", () => {
    expect(parseCommand("/pisa reconcile", "/pisa")).toEqual({ kind: "reconcile", body: "" });
    expect(parseCommand("/pisa reconcile t_1 --fix", "/pisa")).toEqual({
      kind: "reconcile",
      body: "t_1 --fix",
    });
    expect(parseCommand("/pisa 对账", "/pisa")).toEqual({ kind: "reconcile", body: "" });
  });
});
