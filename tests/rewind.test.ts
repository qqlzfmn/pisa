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

function commitFile(dir: string, name: string, body: string): string {
  writeFileSync(join(dir, name), body);
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `add ${name}`);
  return git(dir, "rev-parse", "HEAD");
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-rewind-repo-"));
  git(dir, "init", "-q", "-b", "main");
  commitFile(dir, "README.md", "hello\n");
  return dir;
}

function makeBare(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-rewind-bare-"));
  sh(["git", "init", "-q", "--bare", dir]);
  return dir;
}

function makeCfg(repoPath: string, stateDir: string): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: repoPath, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir,
  };
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

/** 只读 PR 查询返回 OPEN；close 结果按剧本 */
interface GhStub {
  runner: Runner;
  calls: string[][];
}

function ghRunner(state: "OPEN" | "MERGED" | "fail", closeOk = true, mergeCommit: string | null = null): GhStub {
  const calls: string[][] = [];
  const runner: Runner = (args) => {
    calls.push(args);
    if (args[2] === "view") {
      if (state === "fail") return { code: 1, out: "", err: "gh: boom" };
      return { code: 0, out: JSON.stringify({ state, mergeCommit: mergeCommit ? { oid: mergeCommit } : null }), err: "" };
    }
    if (args[2] === "close") {
      return closeOk ? { code: 0, out: "", err: "" } : { code: 1, out: "", err: "gh: close refused" };
    }
    return { code: 0, out: "", err: "" };
  };
  return { runner, calls };
}

describe("rewind 命令解析", () => {
  test("/pisa rewind 是命令而不是任务", () => {
    expect(parseCommand("/pisa rewind t_1", "/pisa")).toEqual({ kind: "rewind", body: "t_1" });
    expect(parseCommand("/pisa rewind t_1 --yes", "/pisa")).toEqual({ kind: "rewind", body: "t_1 --yes" });
  });
});

describe("Router.rewind", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-rewind-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
    cfg = makeCfg(repo, stateDir);
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function build(gh: GhStub) {
    return new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
      ghRunner: gh.runner,
    });
  }

  function seedTask(over: Partial<Task> & { id: string }): Task {
    const { id, ...rest } = over;
    const task: Task = {
      id,
      source: `seed:${id}`,
      channel: "fake",
      chatId: "c1",
      requester: "u1",
      repo: "demo",
      prompt: "做点事",
      mode: "work",
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
    store.insertTask(task);
    return task;
  }

  function seedEffects(id: string, rows: Array<[EffectKind, string, string?]>): void {
    for (const [kind, target, detail] of rows) store.effect(id, kind, target, detail ?? null);
  }

  /** 任务留下本地分支、工作副本、推送、PR 与回帖 */
  function seedDelivered(id = "t_1"): { workdir: string; task: Task } {
    git(repo, "branch", `pisa/${id}`);
    const workdir = join(stateDir, "worktrees", id);
    const added = sh(["git", "-C", repo, "worktree", "add", "-q", workdir, `pisa/${id}`]);
    expect(added.code).toBe(0);
    const task = seedTask({
      id,
      status: "succeeded",
      branch: `pisa/${id}`,
      prUrl: "https://github.com/o/r/pull/12",
    });
    seedEffects(id, [
      ["worktree", workdir],
      ["branch", `pisa/${id}`],
      ["push", "origin", `pisa/${id}`],
      ["pr", "12", "demo"],
      ["comment", "o/r#12", "PR 回帖"],
    ]);
    return { workdir, task };
  }

  test("预览不改动任何东西", async () => {
    const { workdir } = seedDelivered();
    const gh = ghRunner("OPEN");
    const router = build(gh);

    await router.handle(msg("/pisa rewind t_1"));

    const text = channel.last;
    expect(text).toContain("rewind 预览 · t_1");
    expect(text).toContain("未合并（PR 仍打开，将关闭）");
    expect(text).toContain("关闭 PR #12");
    expect(text).toContain("移除工作副本");
    expect(text).toContain("删除本地分支 pisa/t_1");
    expect(text).toContain("删除远程分支 origin/pisa/t_1");
    expect(text).toContain("已发 o/r#12 评论");
    expect(text).toContain("确认执行：/pisa rewind t_1 --yes");

    // 只读：只查了 PR 状态，没有关 PR
    expect(gh.calls.map((c) => c[2])).toEqual(["view"]);
    expect(existsSync(workdir)).toBe(true);
    expect(git(repo, "branch", "--list", "pisa/t_1")).toContain("pisa/t_1");
    expect(store.get("t_1")!.status).toBe("succeeded");
  });

  test("--yes 执行：关 PR、删分支、清可逆账本", async () => {
    const { workdir } = seedDelivered();
    const bare = makeBare();
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-q", "-u", "origin", "pisa/t_1");
    const gh = ghRunner("OPEN");
    const router = build(gh);

    await router.handle(msg("/pisa rewind t_1 --yes"));

    expect(channel.last).toContain("已撤销 · t_1");
    expect(channel.last).toContain("✓ 关闭 PR #12");
    expect(channel.last).toContain("不可撤销");
    expect(gh.calls.map((c) => c[2])).toContain("close");
    expect(existsSync(workdir)).toBe(false);
    expect(git(repo, "branch", "--list", "pisa/t_1")).toBe("");
    expect(git(bare, "branch", "--list", "pisa/t_1")).toBe("");
    expect(store.get("t_1")!.status).toBe("rewound");
    // 已发的回帖不可撤销，账本保留这条记录
    expect(store.effectsOf("t_1").map((e) => e.kind)).toEqual(["comment"]);
    rmSync(bare, { recursive: true, force: true });
  });

  test("已合并的任务用 revert 提交回退", async () => {
    // 造出 pisa 合并过的历史：分支提交后被 ff 合入 main
    git(repo, "branch", "pisa/t_2");
    const wt = join(stateDir, "worktrees", "t_2");
    git(repo, "worktree", "add", "-q", wt, "pisa/t_2");
    const from = git(repo, "rev-parse", "main");
    commitFile(wt, "out.txt", "hi\n");
    git(repo, "worktree", "remove", "--force", wt);
    const merged = sh(["git", "-C", repo, "merge", "--ff-only", "pisa/t_2"]);
    expect(merged.code).toBe(0);
    const to = git(repo, "rev-parse", "main");
    rmSync(wt, { recursive: true, force: true });

    seedTask({ id: "t_2", status: "succeeded", branch: "pisa/t_2" });
    seedEffects("t_2", [
      ["branch", "pisa/t_2"],
      ["merge", "main", JSON.stringify({ base: "main", from, to })],
    ]);
    const router = build(ghRunner("MERGED"));

    await router.handle(msg("/pisa rewind t_2"));
    expect(channel.last).toContain("已合并（用 revert 提交回退，不改写历史）");
    expect(channel.last).toContain("生成 revert 提交");

    await router.handle(msg("/pisa rewind t_2 --yes"));

    expect(channel.last).toContain("已撤销 · t_2");
    expect(existsSync(join(repo, "out.txt"))).toBe(false);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("revert: 撤销 t_2");
    expect(git(repo, "branch", "--list", "pisa/t_2")).toBe("");
    expect(store.get("t_2")!.status).toBe("rewound");
  });

  test("部分失败保留账本，修正后重试完成", async () => {
    seedDelivered();
    const bare = makeBare();
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-q", "-u", "origin", "pisa/t_1");
    let attempt = 0;
    const calls: string[][] = [];
    const flaky: Runner = (args) => {
      calls.push(args);
      if (args[2] === "view") return { code: 0, out: JSON.stringify({ state: "OPEN", mergeCommit: null }), err: "" };
      attempt += 1;
      return attempt === 1 ? { code: 1, out: "", err: "gh: close refused" } : { code: 0, out: "", err: "" };
    };
    const router = new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
      ghRunner: flaky,
    });

    await router.handle(msg("/pisa rewind t_1 --yes"));
    expect(channel.last).toContain("部分失败 · t_1");
    expect(channel.last).toContain("✗ 关闭 PR #12");
    expect(store.get("t_1")!.status).toBe("succeeded");
    expect(store.effectsOf("t_1").map((e) => e.kind)).toEqual(["comment", "pr"]);

    await router.handle(msg("/pisa rewind t_1 --yes"));
    expect(channel.last).toContain("已撤销 · t_1");
    expect(store.get("t_1")!.status).toBe("rewound");
    // 回帖不可撤销，账本保留这条记录
    expect(store.effectsOf("t_1").map((e) => e.kind)).toEqual(["comment"]);
    expect(calls.filter((c) => c[2] === "close")).toHaveLength(2);
    rmSync(bare, { recursive: true, force: true });
  });

  test("PR 状态查不到时保留分支", async () => {
    seedDelivered();
    const router = build(ghRunner("fail"));

    await router.handle(msg("/pisa rewind t_1 --yes"));

    expect(channel.last).toContain("未完成 · t_1");
    expect(channel.last).toContain("PR 状态未知，分支保留");
    expect(channel.last).toContain("修正后重试");
    expect(git(repo, "branch", "--list", "pisa/t_1")).toContain("pisa/t_1");
    expect(store.get("t_1")!.status).toBe("succeeded");
  });

  test("共享分支不删", async () => {
    git(repo, "branch", "pisa/parent");
    seedTask({ id: "t_3", status: "succeeded", branch: "pisa/parent" });
    seedEffects("t_3", [["branch", "pisa/parent", "shared"]]);
    const router = build(ghRunner("OPEN"));

    await router.handle(msg("/pisa rewind t_3 --yes"));

    expect(channel.last).toContain("与上一轮任务共用，保留");
    expect(git(repo, "branch", "--list", "pisa/parent")).toContain("pisa/parent");
    expect(store.get("t_3")!.status).toBe("rewound");
  });

  test("拒绝撤销他人的任务", async () => {
    seedDelivered();
    const router = build(ghRunner("OPEN"));

    await router.handle(msg("/pisa rewind t_1", { userId: "u2" }));

    expect(channel.last).toBe("只有原请求者可以撤销。");
    expect(store.get("t_1")!.status).toBe("succeeded");
  });

  test("找不到任务时不落任务", async () => {
    const router = build(ghRunner("OPEN"));

    await router.handle(msg("/pisa rewind t_missing"));

    expect(channel.last).toBe("找不到任务 t_missing");
    expect(store.recentTasks()).toEqual([]);
  });

  test("运行中的任务要求先取消", async () => {
    seedTask({ id: "t_4", status: "running" });
    const router = build(ghRunner("OPEN"));

    await router.handle(msg("/pisa rewind t_4"));

    expect(channel.last).toContain("还没结束");
    expect(channel.last).toContain("/pisa cancel t_4");
  });

  test("任务执行后副作用进账本", async () => {
    const router = build(ghRunner("OPEN"));
    await router.handle(msg("/pisa 做点事"));
    await router.drainOnce();
    const task = store.recentTasks()[0]!;

    expect(task.status).toBe("succeeded");
    expect(store.effectsOf(task.id).map((e) => e.kind)).toEqual(["branch"]);
    // 工作副本交付后已清理，账本里不应残留
    expect(store.effectsOf(task.id)[0]!.target).toBe(`pisa/${task.id}`);
  });

  test("无副作用任务的预览说明无动作", async () => {
    seedTask({ id: "t_5", status: "failed" });
    const router = build(ghRunner("OPEN"));

    await router.handle(msg("/pisa rewind t_5"));

    expect(channel.last).toContain("没有可撤销的副作用");

    await router.handle(msg("/pisa rewind t_5 --yes"));
    expect(channel.last).toContain("已标记撤销 · t_5");
    expect(store.get("t_5")!.status).toBe("rewound");
  });
});
