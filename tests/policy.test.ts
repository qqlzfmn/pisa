import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { decide, formatPolicy, policyVersion, resolveSource } from "../src/policy";
import { createWorktree, sh } from "../src/git";
import type { Config } from "../src/config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";

const NOW = 1_700_000_000_000;

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: Array<{ chatId: string; text: string }> = [];
  async start(): Promise<void> {}
  async send(chatId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ chatId, text });
    return { messageId: String(this.sent.length) };
  }
  async stop(): Promise<void> {}
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
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

const quietWorker: WorkerRunner = {
  async run(): Promise<WorkerResult> {
    return { ok: true, summary: "无改动", exitCode: 0 };
  },
};

describe("准入判定", () => {
  const cfg = (): Config => ({ ...makeCfg("/tmp/repo", "/tmp/state") });
  const at = NOW;

  test("默认：名单内放行，名单外拒绝", () => {
    const c = cfg();
    const member = decide(c, { source: "feishu", principal: "u1", mentioned: false }, at);
    expect(member.cell).toBe("member.unmentioned");
    expect(member.mode).toBe("auto");

    const stranger = decide(c, { source: "feishu", principal: "ou_x", mentioned: true }, at);
    expect(stranger.cell).toBe("stranger.mentioned");
    expect(stranger.mode).toBe("off");
    expect(stranger.reason).toContain("不在来源 feishu 的准入名单");
  });

  test("单元覆盖：stranger.mentioned=observe 只记录", () => {
    const c = cfg();
    c.policy = { sources: { feishu: { cells: { "stranger.mentioned": "observe" } } } };
    const d = decide(c, { source: "feishu", principal: "ou_x", mentioned: true }, at);
    expect(d.mode).toBe("observe");
    expect(d.reason).toContain("只记录不派活");
  });

  test("来源级 accept 覆盖所有单元", () => {
    const c = cfg();
    c.policy = { sources: { wecom: { accept: "observe" }, cron: { accept: "off" } } };
    expect(decide(c, { source: "wecom", principal: "u1", mentioned: true }, at).mode).toBe("observe");
    expect(decide(c, { source: "cron", principal: "u1", mentioned: true }, at).mode).toBe("off");
  });

  test("allowed 取代全局名单：全局名单内的人在该来源算名单外", () => {
    const c = cfg();
    c.policy = { sources: { webhook: { allowed: ["svc"] } } };
    const resolved = resolveSource(c, "webhook");
    expect(resolved.inherited).toBe(false);
    expect(resolved.allowed).toEqual(["svc"]);
    expect(decide(c, { source: "webhook", principal: "u1", mentioned: true }, at).cell).toBe("stranger.mentioned");
    expect(decide(c, { source: "webhook", principal: "svc", mentioned: true }, at).mode).toBe("auto");
  });

  test("策略版本只随准入相关配置变化", () => {
    const base = policyVersion(cfg());
    expect(policyVersion(cfg())).toBe(base);

    const renamed = cfg();
    renamed.trigger = "/other";
    renamed.worker.concurrency = 4;
    expect(policyVersion(renamed)).toBe(base);

    const widened = cfg();
    widened.whitelist.users.push("u2");
    expect(policyVersion(widened)).not.toBe(base);

    const cellChanged = cfg();
    cellChanged.policy = { sources: { feishu: { cells: { "stranger.mentioned": "observe" } } } };
    expect(policyVersion(cellChanged)).not.toBe(base);
  });

  test("formatPolicy 列出默认块、来源块与版本", () => {
    const c = cfg();
    c.policy = { sources: { feishu: { cells: { "stranger.mentioned": "observe" } } } };
    const text = formatPolicy(c);
    expect(text).toContain(`准入策略 · 版本 ${policyVersion(c)}`);
    expect(text).toContain("默认（未单独配置的来源）");
    expect(text).toContain("feishu");
    expect(text).toContain("stranger.mentioned=observe");
    expect(text).toContain("member.mentioned=auto");
  });
});

describe("准入接入路由", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
    cfg = makeCfg(repo, stateDir);
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function build(worker: WorkerRunner = quietWorker) {
    return new Router({ cfg, store, worker, deliverer: new GitDeliverer(cfg), channel, now: () => NOW });
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
      prompt: "续跑",
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

  test("越权：名单外的群消息被拒，不建任务", async () => {
    const router = build();
    await router.handle(msg("/pisa 修一下", { channel: "feishu", isDirect: false, userId: "ou_x" }));

    expect(store.recentTasks()).toHaveLength(0);
    expect(channel.sent.at(-1)?.text).toContain("无权限");
    expect(channel.sent.at(-1)?.text).toContain("feishu");
  });

  test("降权：关闭 member.unmentioned 后，群里不 @ 的名单内用户被拒", async () => {
    cfg.policy = { sources: { feishu: { cells: { "member.unmentioned": "off" } } } };
    const router = build();

    await router.handle(msg("/pisa 修一下", { channel: "feishu", isDirect: false }));
    expect(store.recentTasks()).toHaveLength(0);
    expect(channel.sent.at(-1)?.text).toContain("关闭了 member.unmentioned 的准入");

    await router.handle(msg("/pisa 修一下", { channel: "feishu", isDirect: false, mentioned: true }));
    expect(store.recentTasks()).toHaveLength(1);
  });

  test("observe：只记录不派活，重复投递不重复提示", async () => {
    cfg.policy = { sources: { feishu: { cells: { "stranger.mentioned": "observe" } } } };
    const router = build();
    const ev = msg("/pisa 修一下", { channel: "feishu", isDirect: false, userId: "ou_x", mentioned: true });

    await router.handle(ev);
    expect(store.recentTasks()).toHaveLength(0);
    expect(channel.sent.at(-1)?.text).toContain("已记录");
    // 观察态消费掉事件，重投不再提示
    expect(store.claimEvent(ev.eventId, "probe")).toBe(false);

    await router.handle(ev);
    expect(channel.sent).toHaveLength(1);
  });

  test("任务记录 mandate 与策略版本", async () => {
    const router = build();
    const ev = msg("/pisa 修一下", { channel: "feishu", isDirect: false, mentioned: true });
    await router.handle(ev);

    const task = store.get(store.recentTasks()[0]!.id)!;
    expect(task.mandate).toMatchObject({
      source: "feishu",
      principal: "u1",
      mentioned: true,
      member: true,
      cell: "member.mentioned",
      mode: "auto",
      policyVersion: policyVersion(cfg),
      decidedAt: NOW,
    });
  });

  test("降权不追溯：已建任务保留建单时的授权，新派活按新策略拒绝", async () => {
    const router = build();
    await router.handle(msg("/pisa 旧任务"));
    const old = store.get(store.recentTasks()[0]!.id)!;
    const oldVersion = old.mandate!.policyVersion;

    cfg.policy = { sources: { fake: { accept: "off" } } };
    expect(policyVersion(cfg)).not.toBe(oldVersion);

    await router.handle(msg("/pisa 新任务"));
    expect(store.recentTasks()).toHaveLength(1);
    expect(channel.sent.at(-1)?.text).toContain("无权限");

    const kept = store.get(old.id)!;
    expect(kept.mandate!.mode).toBe("auto");
    expect(kept.mandate!.policyVersion).toBe(oldVersion);
  });

  test("恢复被拒：当前策略不再放行时拒绝并说明版本", async () => {
    // 建单时放行，随后策略收紧：任务被中断后停在 paused
    const mandate = decide(cfg, { source: "fake", principal: "u1", mentioned: true }, NOW);
    const task = seedTask({ id: "t_policy", status: "running", mandate });
    expect(store.transition(task.id, "paused")).toBe(true);
    const oldVersion = mandate.policyVersion;

    const router = build();

    cfg.policy = { sources: { fake: { accept: "off" } } };
    await router.handle(msg(`/pisa resume ${task.id}`));

    const text = channel.sent.at(-1)!.text;
    expect(text).toContain(`拒绝恢复 · ${task.id}`);
    expect(text).toContain("无权限");
    expect(text).toContain(`建单时策略 ${oldVersion}`);
    expect(text).toContain(`当前策略 ${policyVersion(cfg)}`);
    expect(store.get(task.id)!.status).toBe("paused");
  });

  test("恢复放行：旧任务没有 mandate 时按来源与请求者重判，默认策略照常恢复", async () => {
    const task = seedTask({ id: "t_legacy" });
    const branch = `pisa/${task.id}`;
    expect(store.claimQueued(task.id, NOW, branch)).toBe(true);
    expect(createWorktree(repo, join(stateDir, "worktrees", task.id), branch).code).toBe(0);
    store.setSessionId(task.id, "sess-legacy");
    expect(store.transition(task.id, "paused")).toBe(true);

    const router = build(okWorker);
    await router.handle(msg(`/pisa resume ${task.id}`));
    await router.drainOnce();

    expect(store.get(task.id)!.status).toBe("succeeded");
  });

  test("/pisa policy 输出当前规则与版本且不建任务", async () => {
    cfg.policy = { sources: { feishu: { allowed: ["u1"], accept: "observe" } } };
    const router = build();
    await router.handle(msg("/pisa policy"));

    const text = channel.sent.at(-1)!.text;
    expect(text).toContain(`准入策略 · 版本 ${policyVersion(cfg)}`);
    expect(text).toContain("accept：observe（覆盖所有单元）");
    expect(store.recentTasks()).toHaveLength(0);
  });

  test("私聊 /policy 免触发词", async () => {
    const router = build();
    await router.handle(msg("/policy", { isDirect: true }));
    expect(channel.sent.at(-1)?.text).toContain("准入策略 · 版本");
  });
});
