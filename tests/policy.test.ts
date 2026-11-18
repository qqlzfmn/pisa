import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import type { Config } from "../src/config";
import type { ChannelAdapter, IncomingMessage, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { createWorktree, sh } from "../src/git";
import { decideAdmission, effectivePolicy, formatMandate, formatPolicy } from "../src/policy";

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: Array<{ chatId: string; text: string }> = [];
  async start(): Promise<void> {}
  private seq = 0;
  async send(chatId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ chatId, text });
    this.seq += 1;
    return { messageId: String(this.seq) };
  }
  async stop(): Promise<void> {}
}

const okWorker: WorkerRunner = {
  async run(_task, workdir): Promise<WorkerResult> {
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    return { ok: true, summary: "改了 out.txt", exitCode: 0 };
  },
};

describe("effectivePolicy", () => {
  test("默认值等于改造前行为：IM 认白名单，其余来源不看主体", () => {
    const p = effectivePolicy(undefined, ["u1"]);
    expect(p.sources.im.cells).toEqual({
      inMention: "accept",
      inPlain: "accept",
      outMention: "deny",
      outPlain: "deny",
    });
    for (const source of ["github", "webhook", "cron", "proactive"] as const) {
      expect(Object.values(p.sources[source].cells)).toEqual(["accept", "accept", "accept", "accept"]);
    }
    expect(p.sources.im.accept).toBe("auto");
    expect(p.sources.im.principals).toEqual(["u1"]);
  });

  test("未配置的格取来源默认值，已配置的覆盖", () => {
    const p = effectivePolicy({ sources: { im: { cells: { outMention: "accept" }, accept: "observe" } } }, ["u1"]);
    expect(p.sources.im.cells.outMention).toBe("accept");
    expect(p.sources.im.cells.outPlain).toBe("deny");
    expect(p.sources.im.accept).toBe("observe");
  });

  test("版本由内容决定：同配置恒等，任一字段变化即变", () => {
    const base = effectivePolicy({ sources: { im: { allowed: true } } }, ["u1"]);
    const same = effectivePolicy({ sources: { im: { allowed: true } } }, ["u1"]);
    expect(same.version).toBe(base.version);
    expect(base.version).toMatch(/^[0-9a-f]{8}$/);

    const modes = [
      effectivePolicy({ sources: { im: { accept: "observe" } } }, ["u1"]),
      effectivePolicy({ sources: { im: { cells: { outPlain: "accept" } } } }, ["u1"]),
      effectivePolicy({ sources: { im: { principals: ["u2"] } } }, ["u1"]),
      effectivePolicy({ sources: { github: { allowed: false } } }, ["u1"]),
    ];
    for (const m of modes) expect(m.version).not.toBe(base.version);
    // 内容归一化相同（只写默认值）时版本相同
    expect(effectivePolicy(undefined, ["u1"]).version).toBe(base.version);
    expect(new Set(modes.map((m) => m.version)).size).toBe(modes.length);
  });

  test("principals 缺省沿用 whitelist.users，显式配置时覆盖", () => {
    expect(effectivePolicy(undefined, ["u2", "u1"]).sources.github.principals).toEqual(["u1", "u2"]);
    expect(effectivePolicy({ sources: { github: { principals: ["alice"] } } }, ["u1"]).sources.github.principals).toEqual([
      "alice",
    ]);
  });
});

describe("decideAdmission", () => {
  const policy = effectivePolicy(
    { sources: { github: { cells: { outMention: "deny" }, principals: ["alice"] }, cron: { accept: "off" } } },
    ["u1"],
  );

  test("名单内外 × 是否 @ 命中不同格", () => {
    expect(decideAdmission(policy, { source: "github", principal: "alice", mentioned: true }).cell).toBe("inMention");
    expect(decideAdmission(policy, { source: "github", principal: "alice", mentioned: false }).cell).toBe("inPlain");
    expect(decideAdmission(policy, { source: "github", principal: "bob", mentioned: true }).cell).toBe("outMention");
    expect(decideAdmission(policy, { source: "github", principal: "bob", mentioned: false }).cell).toBe("outPlain");
  });

  test("auto 按格执行，拒绝带原因与版本", () => {
    const denied = decideAdmission(policy, { source: "github", principal: "bob", mentioned: true });
    expect(denied.outcome).toBe("deny");
    expect(denied.reason).toContain("名单外@");
    expect(denied.policyVersion).toBe(policy.version);

    const accepted = decideAdmission(policy, { source: "github", principal: "bob", mentioned: false });
    expect(accepted.outcome).toBe("accept");
    expect(accepted.reason).toBeNull();
  });

  test("off 全部拒绝，observe 全部接单但保留判定", () => {
    const off = decideAdmission(policy, { source: "cron", principal: "u1", mentioned: true });
    expect(off.outcome).toBe("deny");
    expect(off.reason).toContain("off");

    const observe = effectivePolicy({ sources: { im: { accept: "observe" } } }, ["u1"]);
    const m = decideAdmission(observe, { source: "im", principal: "stranger", mentioned: true });
    expect(m.outcome).toBe("observe");
    expect(m.verdict).toBe("deny");
  });

  test("allowed=false 优先于档位", () => {
    const p = effectivePolicy({ sources: { webhook: { allowed: false, accept: "observe" } } }, ["u1"]);
    const m = decideAdmission(p, { source: "webhook", principal: "u1", mentioned: true });
    expect(m.outcome).toBe("deny");
    expect(m.reason).toContain("allowed=false");
  });
});

describe("formatPolicy", () => {
  test("输出版本、五个来源与四格结果", () => {
    const text = formatPolicy(effectivePolicy({ sources: { im: { cells: { outPlain: "accept" } } } }, ["u1"]));
    expect(text).toContain(`版本 ${effectivePolicy({ sources: { im: { cells: { outPlain: "accept" } } } }, ["u1"]).version}`);
    for (const source of ["im", "github", "webhook", "cron", "proactive"]) expect(text).toContain(`${source} · 开`);
    expect(text).toContain("名单外未@接受");
  });

  test("四格全接受的来源标成名单不限", () => {
    const text = formatPolicy(effectivePolicy(undefined, ["u1"]));
    expect(text).toContain("cron · 开 · auto · 名单 不限");
    expect(text).toContain("im · 开 · auto · 名单 u1");
  });
});

describe("mandate 落库", () => {
  test("写入后读回同样内容，一行摘要带主体与版本", () => {
    const s = new Store(":memory:");
    try {
      const ep = effectivePolicy({ sources: { im: { accept: "observe" } } }, ["u1"]);
      const mandate = decideAdmission(ep, { source: "im", principal: "u9", mentioned: true });
      s.insertTask({
        id: "t_mandate",
        source: "telegram:1:1",
        channel: "telegram",
        chatId: "c1",
        requester: "u9",
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
        mandate,
        summary: null,
        error: null,
        createdAt: 0,
        startedAt: null,
        endedAt: null,
        cancelRequested: false,
      });
      expect(s.get("t_mandate")?.mandate).toEqual(mandate);
      expect(formatMandate(mandate)).toBe(`IM · u9 · 名单外@ · 观察 · 策略 ${ep.version}`);
    } finally {
      s.close();
    }
  });
});

describe("Router 准入", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "pisa-policy-repo-"));
    sh(["git", "init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "README.md"), "hello\n");
    sh(["git", "-C", repo, "add", "-A"]);
    sh(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    stateDir = mkdtempSync(join(tmpdir(), "pisa-policy-state-"));
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
    rmSync(stateDir, { recursive: true, force: true });
  });

  function build() {
    return new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
      now: Date.now,
    });
  }

  function msg(text: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
    return {
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      channel: "telegram",
      chatId: "c1",
      userId: "u1",
      text,
      ...over,
    };
  }

  test("越权：名单外 @ 被矩阵拒绝，回执带原因与版本", async () => {
    const router = build();
    await router.handle(msg("/pisa 做点事", { userId: "stranger" }));

    expect(store.recentTasks()).toHaveLength(0);
    const text = channel.sent[0]?.text ?? "";
    expect(text).toContain("无权限");
    expect(text).toContain("名单外@");
    expect(text).toContain(effectivePolicy(cfg.policy, cfg.whitelist.users).version);
  });

  test("矩阵可放宽：名单外 @ 设接受后 stranger 也能派活", async () => {
    cfg.policy = { sources: { im: { cells: { outMention: "accept" } } } };
    const router = build();
    await router.handle(msg("/pisa 做点事", { userId: "stranger" }));

    const task = store.recentTasks()[0]!;
    expect(task.mandate?.cell).toBe("outMention");
    expect(task.mandate?.outcome).toBe("accept");
    expect(task.mandate?.principal).toBe("stranger");
  });

  test("GitHub 评论：主体是评论作者，收紧后可被拒", async () => {
    const router = build();
    await router.handle(
      msg("/pisa 修一下", { channel: "github", userId: "ua", principal: "alice", mentioned: true, replyPr: 7 }),
    );
    expect(store.recentTasks()[0]?.mandate?.source).toBe("github");
    expect(store.recentTasks()[0]?.mandate?.principal).toBe("alice");

    cfg.policy = { sources: { github: { cells: { outMention: "deny" } } } };
    channel.sent.length = 0;
    await router.handle(
      msg("/pisa 再改一处", { channel: "github", userId: "ua", principal: "mallory", mentioned: true, replyPr: 7 }),
    );
    expect(store.recentTasks()).toHaveLength(1);
    expect(channel.sent[0]?.text).toContain("无权限");
  });

  test("降权：observe 档接单并记账，不拦截", async () => {
    cfg.policy = { sources: { im: { accept: "observe", cells: { outMention: "deny" } } } };
    const router = build();
    await router.handle(msg("/pisa 做点事", { userId: "stranger" }));

    const task = store.recentTasks()[0]!;
    expect(task.mandate?.outcome).toBe("observe");
    expect(task.mandate?.verdict).toBe("deny");
    expect(task.mandate?.mode).toBe("observe");
    expect(channel.sent.at(-1)?.text).toContain("观察");
  });

  test("策略不追溯已接任务，只影响后续派活", async () => {
    const router = build();
    await router.handle(msg("/pisa 第一个任务"));
    const before = store.recentTasks()[0]!;
    expect(before.mandate?.outcome).toBe("accept");

    cfg.policy = { sources: { im: { allowed: false } } };
    await router.handle(msg("/pisa 第二个任务"));
    expect(store.recentTasks()).toHaveLength(1);
    expect(store.get(before.id)?.mandate).toEqual(before.mandate);
  });

  test("恢复前重校验：收紧后拒绝恢复，任务保持中断；放宽后可恢复", async () => {
    const router = build();
    await router.handle(msg("/pisa 新建 out.txt"));
    const task = store.recentTasks()[0]!;
    const branch = `pisa/${task.id}`;
    const workdir = join(stateDir, "worktrees", task.id);
    expect(store.claimQueued(task.id, Date.now(), branch)).toBe(true);
    expect(createWorktree(repo, workdir, branch).code).toBe(0);
    store.setSessionId(task.id, "sess-1");
    expect(store.transition(task.id, "paused")).toBe(true);

    const granted = store.get(task.id)!.mandate!;
    cfg.policy = { sources: { im: { allowed: false } } };
    await router.handle(msg(`/pisa resume ${task.id}`));

    const refusal = channel.sent.at(-1)!.text;
    expect(refusal).toContain("拒绝恢复");
    expect(refusal).toContain("allowed=false");
    expect(refusal).toContain(granted.policyVersion);
    expect(refusal).toContain(effectivePolicy(cfg.policy, cfg.whitelist.users).version);
    expect(store.get(task.id)?.status).toBe("paused");

    cfg.policy = undefined;
    await router.handle(msg(`/pisa resume ${task.id}`));
    expect(channel.sent.some((s) => s.text.includes("恢复执行"))).toBe(true);
    await router.drainOnce();
    expect(store.get(task.id)?.status).toBe("succeeded");
  });

  test("/pisa policy 输出当前规则与版本", async () => {
    cfg.policy = { sources: { github: { accept: "observe" } } };
    const router = build();
    await router.handle(msg("/pisa policy"));

    const text = channel.sent.at(-1)!.text;
    expect(text).toContain(effectivePolicy(cfg.policy, cfg.whitelist.users).version);
    expect(text).toContain("github · 开 · observe");
    expect(text).toContain("名单内@接受");
    expect(store.recentTasks()).toHaveLength(0);
  });

  test("off 档一律不接单", async () => {
    cfg.policy = { sources: { im: { accept: "off" } } };
    const router = build();
    await router.handle(msg("/pisa 做点事"));
    expect(store.recentTasks()).toHaveLength(0);
    expect(channel.sent[0]?.text).toContain("档位为 off");
  });
});
