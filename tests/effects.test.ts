import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EffectQueue, effectBackoffMs } from "../src/effects";
import { GitDeliverer } from "../src/deliver";
import { createWorktree, sh } from "../src/git";
import { Store } from "../src/store";
import type { Config } from "../src/config";
import type { Task } from "../src/types";

const baseTask: Task = {
  id: "t_seed",
  source: "s",
  channel: "fake",
  chatId: "c1",
  requester: "u1",
  repo: "demo",
  prompt: "上一轮",
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

/** 可推进的时钟：退避与到期判断都靠它，测试不等待真实时间 */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number): void {
      t += ms;
    },
  };
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-fx-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

describe("effectBackoffMs", () => {
  test("2s 起每次翻倍，封顶 60s", () => {
    expect([0, 1, 2, 3, 5, 6, 7].map(effectBackoffMs)).toEqual([0, 2_000, 4_000, 8_000, 32_000, 60_000, 60_000]);
  });
});

describe("EffectQueue", () => {
  const stores: Store[] = [];

  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
  });

  function make(now?: () => number) {
    const store = new Store(":memory:");
    stores.push(store);
    return { store, effects: new EffectQueue(now ? { store, now } : { store }) };
  }

  test("同一 (kind,key) 只执行一次，重复入队保留首次载荷", async () => {
    const { effects } = make();
    const seen: unknown[] = [];
    effects.register("push", (payload) => {
      seen.push(payload);
    });

    effects.enqueue("push", "t1", { branch: "first" });
    effects.enqueue("push", "t1", { branch: "second" });

    expect(await effects.flush("push", "t1")).toBe(true);
    expect(await effects.flush("push", "t1")).toBe(true);
    expect(seen).toEqual([{ branch: "first" }]);
    expect(effects.state("push", "t1")!.attempts).toBe(0);
  });

  test("失败后按退避排期，到期才重试，成功记结果", async () => {
    const c = clock();
    const { effects } = make(c.now);
    let calls = 0;
    effects.register("push", () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { branch: "done" };
    });
    effects.enqueue("push", "t1", null, "t1");

    expect(await effects.flush("push", "t1")).toBe(false);
    const failed = effects.state("push", "t1")!;
    expect(failed.state).toBe("pending");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe("boom");
    expect(failed.nextAt).toBe(c.now() + 2_000);

    c.advance(1_999);
    expect(await effects.drainDue()).toBe(0);
    c.advance(1);
    expect(await effects.drainDue()).toBe(1);
    expect(calls).toBe(2);
    const done = effects.state("push", "t1")!;
    expect(done.state).toBe("done");
    expect(done.result).toEqual({ branch: "done" });
  });

  test("连续失败间隔 2s→4s→…→60s 封顶", async () => {
    const c = clock();
    const { effects } = make(c.now);
    effects.register("push", () => {
      throw new Error("still down");
    });
    effects.enqueue("push", "t1", null);

    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      expect(await effects.flush("push", "t1")).toBe(false);
      const row = effects.state("push", "t1")!;
      waits.push(row.nextAt - c.now());
      c.advance(row.nextAt - c.now());
    }
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
  });

  test("重启后卡在 running 的动作继续执行", async () => {
    const c = clock();
    const { store, effects } = make(c.now);
    effects.enqueue("pr", "t1", { head: "pisa/t1" }, "t1");
    // 模拟上次进程执行到一半崩溃：行已被占位为 running
    expect(store.claimEffect("pr", "t1", c.now())).not.toBeNull();

    const seen: string[] = [];
    effects.register("pr", (payload) => {
      if (!payload || typeof payload !== "object" || !("head" in payload) || typeof payload.head !== "string") {
        throw new Error("载荷缺少 head");
      }
      seen.push(payload.head);
      return "https://github.com/o/r/pull/1";
    });
    effects.start(60_000);
    expect(effects.state("pr", "t1")!.state).toBe("pending");

    expect(await effects.drainDue()).toBe(1);
    expect(seen).toEqual(["pisa/t1"]);
    expect(effects.state("pr", "t1")!.state).toBe("done");
    await effects.stop();
  });

  test("任务撤销后未完成的动作不再执行", async () => {
    const c = clock();
    const { store, effects } = make(c.now);
    let calls = 0;
    effects.register("comment", () => {
      calls += 1;
      throw new Error("no token");
    });
    effects.enqueue("comment", "t1:pr:o/r#1", null, "t1");
    expect(await effects.flush("comment", "t1:pr:o/r#1")).toBe(false);

    expect(store.cancelEffects("t1", "任务已撤销")).toBe(1);
    c.advance(60_000);
    expect(await effects.drainDue()).toBe(0);
    expect(calls).toBe(1);
  });
});

describe("GitDeliverer 动作入队", () => {
  let repo: string;
  let bare: string;
  let stateDir: string;
  let store: Store;

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function setup(): { cfg: Config; workdir: string; branch: string } {
    repo = makeRepo();
    bare = mkdtempSync(join(tmpdir(), "pisa-fx-bare-"));
    sh(["git", "init", "--bare", "-q", bare]);
    sh(["git", "-C", repo, "remote", "add", "origin", bare]);
    stateDir = mkdtempSync(join(tmpdir(), "pisa-fx-state-"));
    store = new Store(join(stateDir, "pisa.db"));
    const cfg = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: ["u1"], repos: ["demo"] },
      repos: [{ alias: "demo", path: repo, baseBranch: "main", remote: "https://github.com/o/r.git" }],
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: true, pr: true, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      stateDir,
    } satisfies Config;
    const branch = "pisa/t_fix";
    expect(sh(["git", "-C", repo, "branch", branch, "main"]).code).toBe(0);
    const workdir = join(stateDir, "wt");
    expect(createWorktree(repo, workdir, branch).code).toBe(0);
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    store.insertTask({ ...baseTask, id: "t_fix", branch, status: "running", repo: "demo" });
    return { cfg, workdir, branch };
  }

  test("重放时复用已有 PR，不再新建", async () => {
    const c = clock();
    const { cfg, workdir, branch } = setup();
    const effects = new EffectQueue({ store, now: c.now });
    const created: string[] = [];
    const deliverer = new GitDeliverer(cfg, {
      store,
      effects,
      hasGh: () => true,
      findPr: () => ({ ok: true, value: "https://github.com/o/r/pull/7" }),
      createPr: () => {
        created.push("called");
        return { code: 0, out: "https://github.com/o/r/pull/99", err: "" };
      },
    });

    const res = await deliverer.deliver({ ...baseTask, id: "t_fix", branch }, workdir, cfg.repos[0]!);

    expect(created).toEqual([]);
    expect(res.pushed).toBe(true);
    expect(res.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(store.get("t_fix")!.prUrl).toBe("https://github.com/o/r/pull/7");
    expect(store.effectsOf("t_fix").map((e) => `${e.kind}:${e.target}`).sort()).toEqual(["pr:7", "push:origin"]);
    expect(effects.state("pr", "t_fix")!.state).toBe("done");
  });

  test("推送失败只排期重试，不抛错；PR 等推送完成后再建", async () => {
    const c = clock();
    const { cfg, workdir, branch } = setup();
    sh(["git", "-C", repo, "remote", "set-url", "origin", "/nonexistent/bare"]);
    const effects = new EffectQueue({ store, now: c.now });
    const created: string[] = [];
    const deliverer = new GitDeliverer(cfg, {
      store,
      effects,
      hasGh: () => true,
      findPr: () => ({ ok: true, value: null }),
      createPr: () => {
        created.push("called");
        return { code: 0, out: "https://github.com/o/r/pull/42", err: "" };
      },
    });

    const res = await deliverer.deliver({ ...baseTask, id: "t_fix", branch }, workdir, cfg.repos[0]!);

    expect(res.pushed).toBe(false);
    expect(res.prUrl).toBeUndefined();
    const push = effects.state("push", "t_fix")!;
    expect(push.state).toBe("pending");
    expect(push.attempts).toBe(1);
    expect(push.lastError).toContain("推送失败");
    expect(effects.state("pr", "t_fix")!.lastError).toContain("分支尚未推送完成");
    expect(created).toEqual([]);
    expect(store.get("t_fix")!.prUrl).toBeNull();

    // 远端恢复后到期重试：先推送再建 PR
    sh(["git", "-C", repo, "remote", "set-url", "origin", bare]);
    c.advance(2_000);
    await effects.drainDue();
    c.advance(60_000);
    await effects.drainDue();

    expect(effects.state("push", "t_fix")!.state).toBe("done");
    expect(effects.state("pr", "t_fix")!.state).toBe("done");
    expect(created).toEqual(["called"]);
    expect(store.get("t_fix")!.prUrl).toBe("https://github.com/o/r/pull/42");
  });
});
