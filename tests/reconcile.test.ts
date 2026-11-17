import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { parseCommand, type Config } from "../src/config";
import type { ChannelAdapter, EffectKind, IncomingMessage, Task, WorkerResult } from "../src/types";
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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-reconcile-repo-"));
  git(dir, "init", "-q", "-b", "main");
  commitFile(dir, "README.md", "hello\n");
  return dir;
}

function makeBare(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-reconcile-bare-"));
  sh(["git", "init", "-q", "--bare", dir]);
  return dir;
}

function msg(text: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    channel: "fake",
    chatId: "c1",
    userId: "u1",
    text,
    ...over,
  };
}

const okWorker: WorkerRunner = {
  async run(_task, workdir): Promise<WorkerResult> {
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    return { ok: true, summary: "改了 out.txt", exitCode: 0 };
  },
};

interface GhStub {
  runner: Runner;
  /** 关闭过的 PR 号 */
  closed: number[];
}

function ghRunner(open: Array<{ number: number; head: string }>, opts: { fail?: boolean } = {}): GhStub {
  const closed: number[] = [];
  const remaining = [...open];
  const runner: Runner = (args) => {
    if (opts.fail) return { code: 1, out: "", err: "gh: unavailable" };
    if (args[2] === "list") {
      return {
        code: 0,
        out: JSON.stringify(remaining.map((p) => ({ number: p.number, headRefName: p.head, url: `https://github.com/o/r/pull/${p.number}` }))),
        err: "",
      };
    }
    if (args[2] === "close") {
      const n = Number(args[3]);
      closed.push(n);
      const at = remaining.findIndex((p) => p.number === n);
      if (at >= 0) remaining.splice(at, 1);
      return { code: 0, out: "", err: "" };
    }
    return { code: 0, out: "", err: "" };
  };
  return { runner, closed };
}

const FAILED = "t_20260101_aaaa";
const RUNNING = "t_20260102_bbbb";
const DONE = "t_20260103_cccc";
const ORPHAN = "t_20260104_dddd";
const OTHER = "t_20260105_eeee";

describe("reconcile 命令解析", () => {
  test("/pisa reconcile 是命令而不是任务", () => {
    expect(parseCommand("/pisa reconcile", "/pisa")).toEqual({ kind: "reconcile", body: "" });
    expect(parseCommand("/pisa reconcile t_1 --fix", "/pisa")).toEqual({ kind: "reconcile", body: "t_1 --fix" });
  });
});

describe("Router.reconcile", () => {
  let repo: string;
  let bare: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;

  beforeEach(() => {
    repo = makeRepo();
    bare = makeBare();
    git(repo, "remote", "add", "origin", bare);
    stateDir = mkdtempSync(join(tmpdir(), "pisa-reconcile-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
    cfg = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: ["u1"], repos: ["demo"] },
      // remote 只用于解析 owner/repo，实际推送走本机 bare origin
      repos: [{ alias: "demo", path: repo, remote: "git@github.com:o/r.git", baseBranch: "main" }],
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      stateDir,
    } as Config;
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function build(gh: GhStub): Router {
    return new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
      ghRunner: gh.runner,
    });
  }

  function seedTask(id: string, status: Task["status"]): void {
    const task: Task = {
      id,
      source: `seed:${id}`,
      channel: "fake",
      chatId: "c1",
      requester: "u1",
      repo: "demo",
      prompt: "做点事",
      status,
      branch: `pisa/${id}`,
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
    store.insertTask(task);
  }

  function seedEffects(id: string, rows: Array<[EffectKind, string, string?]>): void {
    for (const [kind, target, detail] of rows) store.effect(id, kind, target, detail ?? null);
  }

  /** 建本地分支、工作副本并推到 bare，模拟任务残留 */
  function leaveResidue(id: string): string {
    git(repo, "branch", `pisa/${id}`);
    const workdir = join(stateDir, "worktrees", id);
    mkdirSync(join(stateDir, "worktrees"), { recursive: true });
    const added = sh(["git", "-C", repo, "worktree", "add", "-q", workdir, `pisa/${id}`]);
    expect(added.code).toBe(0);
    const pushed = sh(["git", "-C", repo, "push", "-q", "-u", "origin", `pisa/${id}`]);
    expect(pushed.code).toBe(0);
    return workdir;
  }

  function seedAll(): { failedWt: string; runningWt: string; doneWt: string; orphanWt: string } {
    const failedWt = leaveResidue(FAILED);
    const runningWt = leaveResidue(RUNNING);
    const doneWt = leaveResidue(DONE);
    const orphanWt = leaveResidue(ORPHAN);
    seedTask(FAILED, "failed");
    seedTask(RUNNING, "running");
    seedTask(DONE, "succeeded");
    seedEffects(FAILED, [
      ["worktree", failedWt],
      ["branch", `pisa/${FAILED}`],
      ["push", "origin", `pisa/${FAILED}`],
      ["pr", "7", "demo"],
    ]);
    seedEffects(RUNNING, [
      ["worktree", runningWt],
      ["branch", `pisa/${RUNNING}`],
      ["push", "origin", `pisa/${RUNNING}`],
      ["pr", "8", "demo"],
    ]);
    seedEffects(DONE, [
      ["worktree", doneWt],
      ["branch", `pisa/${DONE}`],
      ["push", "origin", `pisa/${DONE}`],
      ["pr", "9", "demo"],
    ]);
    return { failedWt, runningWt, doneWt, orphanWt };
  }

  const openPrs = [
    { number: 7, head: `pisa/${FAILED}` },
    { number: 8, head: `pisa/${RUNNING}` },
    { number: 9, head: `pisa/${DONE}` },
    { number: 10, head: `pisa/${ORPHAN}` },
  ];

  test("预览只读：列出清理项与保留项，不改动任何资源", async () => {
    const { failedWt, runningWt, doneWt, orphanWt } = seedAll();
    const gh = ghRunner(openPrs);
    const router = build(gh);

    await router.handle(msg("/pisa reconcile"));

    const text = channel.last;
    expect(text).toContain(`reconcile · 全部任务（3）`);
    expect(text).toContain(`删除本地分支 pisa/${FAILED}（任务 ${FAILED} failed）`);
    expect(text).toContain(`删除远程分支 origin/pisa/${FAILED}（任务 ${FAILED} failed）`);
    expect(text).toContain("关闭 PR #7");
    expect(text).toContain(`移除工作副本 ${failedWt}`);
    expect(text).toContain(`删除本地分支 pisa/${ORPHAN}（无任务记录）`);
    expect(text).toContain("关闭 PR #10");
    expect(text).toContain(`移除工作副本 ${doneWt}（任务 ${DONE} succeeded）`);
    expect(text).toContain(`本地分支 pisa/${RUNNING}（任务 ${RUNNING} running，保留）`);
    expect(text).toContain(`本地分支 pisa/${DONE}（任务 ${DONE} 成功，保留）`);
    expect(text).toContain(`工作副本 ${runningWt}（任务 ${RUNNING} running，保留）`);
    expect(text).toContain("确认清理：/pisa reconcile --fix");

    // 只读：分支、worktree 都在，gh 没有关闭调用，账本没动
    expect(git(repo, "branch", "--list", `pisa/${FAILED}`)).toContain(`pisa/${FAILED}`);
    expect(git(bare, "branch", "--list", `pisa/${FAILED}`)).toContain(`pisa/${FAILED}`);
    expect(existsSync(failedWt)).toBe(true);
    expect(existsSync(runningWt)).toBe(true);
    expect(existsSync(doneWt)).toBe(true);
    expect(existsSync(orphanWt)).toBe(true);
    expect(gh.closed).toEqual([]);
    expect(store.effectsOf(FAILED)).toHaveLength(4);
  });

  test("pisa/ 下非任务号分支与 PR 不视为残留", async () => {
    git(repo, "branch", "pisa/manual-work");
    const gh = ghRunner([{ number: 11, head: "pisa/manual-work" }]);
    const router = build(gh);

    await router.handle(msg("/pisa reconcile --fix"));

    expect(channel.last).not.toContain("pisa/manual-work");
    expect(channel.last).toContain("没有可清理的残留");
    expect(git(repo, "branch", "--list", "pisa/manual-work")).toContain("pisa/manual-work");
    expect(gh.closed).toEqual([]);
  });

  test("--fix 清理失败任务与孤儿，保留运行中与成功任务的交付物", async () => {
    const { failedWt, runningWt, doneWt, orphanWt } = seedAll();
    const gh = ghRunner(openPrs);
    const router = build(gh);

    await router.handle(msg("/pisa reconcile --fix"));

    expect(channel.last).toContain("已清理：9/9");
    // 失败任务：分支、远程、worktree、PR 全清
    expect(git(repo, "branch", "--list", `pisa/${FAILED}`)).toBe("");
    expect(git(bare, "branch", "--list", `pisa/${FAILED}`)).toBe("");
    expect(existsSync(failedWt)).toBe(false);
    // 孤儿同样清掉
    expect(git(repo, "branch", "--list", `pisa/${ORPHAN}`)).toBe("");
    expect(git(bare, "branch", "--list", `pisa/${ORPHAN}`)).toBe("");
    expect(existsSync(orphanWt)).toBe(false);
    expect(gh.closed.sort((a, b) => a - b)).toEqual([7, 10]);
    // 运行中：全部保留
    expect(git(repo, "branch", "--list", `pisa/${RUNNING}`)).toContain(`pisa/${RUNNING}`);
    expect(git(bare, "branch", "--list", `pisa/${RUNNING}`)).toContain(`pisa/${RUNNING}`);
    expect(existsSync(runningWt)).toBe(true);
    expect(store.effectsOf(RUNNING)).toHaveLength(4);
    // 成功任务：分支/远程/PR 保留，工作副本回收
    expect(git(repo, "branch", "--list", `pisa/${DONE}`)).toContain(`pisa/${DONE}`);
    expect(git(bare, "branch", "--list", `pisa/${DONE}`)).toContain(`pisa/${DONE}`);
    expect(existsSync(doneWt)).toBe(false);
    expect(store.effectsOf(DONE).map((e) => e.kind)).toEqual(["branch", "pr", "push"]);

    // 再跑一次：没有新动作
    gh.closed.length = 0;
    await router.handle(msg("/pisa reconcile --fix"));
    expect(channel.last).toContain("没有可清理的残留");
    expect(gh.closed).toEqual([]);
  });

  test("单个动作失败不阻断其余清理", async () => {
    const wt = leaveResidue(FAILED);
    seedTask(FAILED, "failed");
    seedEffects(FAILED, [
      ["worktree", wt],
      ["branch", `pisa/${FAILED}`],
      ["push", "origin", `pisa/${FAILED}`],
      ["pr", "7", "demo"],
    ]);
    const runner: Runner = (args) =>
      args[2] === "list"
        ? { code: 0, out: JSON.stringify([{ number: 7, headRefName: `pisa/${FAILED}`, url: "https://github.com/o/r/pull/7" }]), err: "" }
        : { code: 1, out: "", err: "gh: 403" };
    const router = new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
      ghRunner: runner,
    });

    await router.handle(msg("/pisa reconcile --fix"));

    expect(channel.last).toContain("✗ 关闭 PR #7");
    expect(channel.last).toContain("部分失败");
    expect(git(repo, "branch", "--list", `pisa/${FAILED}`)).toBe("");
    expect(existsSync(wt)).toBe(false);
    expect(store.effectsOf(FAILED).map((e) => e.kind)).toEqual(["pr"]);
  });

  test("资源已不存在时清掉账本行", async () => {
    seedTask(DONE, "succeeded");
    seedEffects(DONE, [
      ["branch", `pisa/${DONE}`],
      ["push", "origin", `pisa/${DONE}`],
      ["worktree", join(stateDir, "worktrees", DONE)],
    ]);
    const gh = ghRunner([]);
    const router = build(gh);

    await router.handle(msg(`/pisa reconcile ${DONE}`));
    expect(channel.last).toContain(`删除账本记录：${DONE} · 本地分支`);
    expect(channel.last).toContain(`删除账本记录：${DONE} · 远程分支`);
    expect(channel.last).toContain(`删除账本记录：${DONE} · 工作副本`);

    await router.handle(msg(`/pisa reconcile ${DONE} --fix`));
    expect(store.effectsOf(DONE)).toEqual([]);
  });

  test("带任务号只核对一个任务", async () => {
    leaveResidue(FAILED);
    leaveResidue(OTHER);
    seedTask(FAILED, "failed");
    seedTask(OTHER, "failed");
    const gh = ghRunner([]);
    const router = build(gh);

    await router.handle(msg(`/pisa reconcile ${FAILED}`));

    const text = channel.last;
    expect(text).toContain(`reconcile · 任务 ${FAILED}`);
    expect(text).toContain(`pisa/${FAILED}`);
    expect(text).not.toContain(`pisa/${OTHER}`);
  });

  test("运行中任务的资源在 --fix 下保留", async () => {
    const runningWt = leaveResidue(RUNNING);
    seedTask(RUNNING, "running");
    seedEffects(RUNNING, [
      ["worktree", runningWt],
      ["branch", `pisa/${RUNNING}`],
      ["push", "origin", `pisa/${RUNNING}`],
    ]);
    const router = build(ghRunner([]));

    await router.handle(msg("/pisa reconcile --fix"));

    expect(channel.last).toContain("没有可清理的残留");
    expect(existsSync(runningWt)).toBe(true);
    expect(git(repo, "branch", "--list", `pisa/${RUNNING}`)).toContain(`pisa/${RUNNING}`);
    expect(store.effectsOf(RUNNING)).toHaveLength(3);
  });

  test("远程与 gh 不可用时只报告无法确认", async () => {
    const failedWt = leaveResidue(FAILED);
    seedTask(FAILED, "failed");
    seedEffects(FAILED, [["branch", `pisa/${FAILED}`]]);
    const router = build(ghRunner([], { fail: true }));

    await router.handle(msg("/pisa reconcile"));

    expect(channel.last).toContain("PR：仓库 demo 无法查询");
    // 本地分支仍可判定，失败任务的分支照常列入清理
    expect(channel.last).toContain(`删除本地分支 pisa/${FAILED}`);
    expect(existsSync(failedWt)).toBe(true);
  });

  test("任务号格式无效时直接拒绝", async () => {
    const router = build(ghRunner([]));

    await router.handle(msg("/pisa reconcile foo --fix"));

    expect(channel.last).toContain("任务号无效：foo");
  });

  test("非白名单用户不能执行", async () => {
    const router = build(ghRunner([]));

    await router.handle(msg("/pisa reconcile --fix", { userId: "u2" }));

    expect(channel.last).toBe("无权限：该用户不在白名单。");
  });
});
