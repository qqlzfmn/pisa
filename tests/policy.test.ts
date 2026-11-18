import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { resolvePolicy } from "../src/policy";
import type { Config, PolicyConfig } from "../src/config";
import type { ChannelAdapter, IncomingMessage, Task, TaskMandate, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh } from "../src/git";

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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function makeCfg(repoPath: string, stateDir: string, policy?: PolicyConfig): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: repoPath, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    ...(policy ? { policy } : {}),
    stateDir,
  };
}

const okWorker: WorkerRunner = {
  async run(_task, workdir): Promise<WorkerResult> {
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    return { ok: true, summary: "改了 out.txt", exitCode: 0 };
  },
};

const mandate: TaskMandate = {
  source: "github",
  actor: "alice",
  listed: true,
  mentioned: true,
  decision: "allow",
  mode: "auto",
  reason: null,
};

describe("来源准入", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function msg(text: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
    return { eventId: `evt-${Math.random().toString(36).slice(2)}`, channel: "github", chatId: "c1", userId: "u1", text, ...over };
  }

  function build(cfg: Config): Router {
    return new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel });
  }

  function seed(over: Partial<Task> & { id: string }): Task {
    const { id, ...rest } = over;
    const task: Task = {
      id,
      source: `seed:${id}`,
      channel: "github",
      chatId: "c1",
      requester: "u1",
      repo: "demo",
      prompt: "接着修",
      status: "paused",
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

  function lastSent(): string {
    return channel.sent.at(-1)?.text ?? "";
  }

  function sentAny(text: string): boolean {
    return channel.sent.some((m) => m.text.includes(text));
  }

  test("名单外的人派活被拒，并说明原因与策略版本", async () => {
    const cfg = makeCfg(repo, stateDir, { sources: { github: { allowed: ["alice"] } } });
    const version = resolvePolicy(cfg).version;
    await build(cfg).handle(msg("/pisa 修一下登录", { actor: "mallory" }));

    expect(store.countByStatus().queued).toBe(0);
    expect(lastSent()).toContain("拒绝派活");
    expect(lastSent()).toContain("mallory 不在来源 github 的准入名单");
    expect(lastSent()).toContain(version);
  });

  test("名单内的人派活放行，任务记下凭据与策略版本", async () => {
    const cfg = makeCfg(repo, stateDir, { sources: { github: { allowed: ["alice"] } } });
    const version = resolvePolicy(cfg).version;
    await build(cfg).handle(msg("/pisa 修一下登录", { actor: "alice" }));

    const [task] = store.recentTasks();
    expect(task).toBeDefined();
    expect(task!.requester).toBe("u1");
    expect(task!.mandate).toEqual({
      source: "github",
      actor: "alice",
      listed: true,
      mentioned: true,
      decision: "allow",
      mode: "auto",
      reason: null,
    });
    expect(task!.policyVersion).toBe(version);
  });

  test("群里没 @ 机器人不收，放开这一格后才收", async () => {
    const closed = makeCfg(repo, stateDir, { sources: { feishu: { allowed: ["ou_1"] } } });
    await build(closed).handle(msg("/pisa 修一下登录", { channel: "feishu", actor: "ou_1", mentioned: false }));
    expect(store.countByStatus().queued).toBe(0);
    expect(lastSent()).toContain("不接受未 @ 机器人的消息");

    const open = makeCfg(repo, stateDir, {
      sources: { feishu: { allowed: ["ou_1"], admit: { listed: { unmentioned: "allow" } } } },
    });
    await build(open).handle(msg("/pisa 修一下登录", { channel: "feishu", actor: "ou_1", mentioned: false }));
    expect(store.countByStatus().queued).toBe(1);
  });

  test("observe 只记录不拦：越权任务照建，凭据里留拒绝判定", async () => {
    const cfg = makeCfg(repo, stateDir, { sources: { github: { allowed: ["alice"], accept: "observe" } } });
    await build(cfg).handle(msg("/pisa 修一下登录", { actor: "mallory" }));

    const [task] = store.recentTasks();
    expect(task).toBeDefined();
    expect(task!.mandate?.decision).toBe("deny");
    expect(task!.mandate?.mode).toBe("observe");
    expect(task!.mandate?.reason).toContain("准入名单");
    expect(store.get(task!.id)?.mandate).toEqual(task!.mandate);
  });

  test("off 直接关掉来源，连名单内的人也不收", async () => {
    const cfg = makeCfg(repo, stateDir, { sources: { github: { allowed: ["alice"], accept: "off" } } });
    await build(cfg).handle(msg("/pisa 修一下登录", { actor: "alice" }));

    expect(store.countByStatus().queued).toBe(0);
    expect(lastSent()).toContain("来源 github 已关闭");
  });

  test("降权后恢复被拒：状态不变，说明版本变化", async () => {
    const before = makeCfg(repo, stateDir, { sources: { github: { allowed: ["alice"] } } });
    const oldVersion = resolvePolicy(before).version;
    const task = seed({ id: "t_paused", mandate, policyVersion: oldVersion, branch: "pisa/t_paused" });
    mkdirSync(join(stateDir, "worktrees", task.id), { recursive: true });

    const after = makeCfg(repo, stateDir, { sources: { github: { allowed: ["bob"] } } });
    const newVersion = resolvePolicy(after).version;
    await build(after).handle(msg("/pisa resume t_paused", { userId: "u1" }));

    expect(store.get(task.id)?.status).toBe("paused");
    expect(lastSent()).toContain(`拒绝恢复 · ${task.id}`);
    expect(lastSent()).toContain("alice 不在来源 github 的准入名单");
    expect(lastSent()).toContain(`${oldVersion} → 当前 ${newVersion}`);
  });

  test("策略未变时恢复放行", async () => {
    const cfg = makeCfg(repo, stateDir, { sources: { github: { allowed: ["alice"] } } });
    const task = seed({ id: "t_ok", mandate, policyVersion: resolvePolicy(cfg).version, branch: "pisa/t_ok" });
    mkdirSync(join(stateDir, "worktrees", task.id), { recursive: true });
    store.transition(task.id, "paused", {});

    await build(cfg).handle(msg("/pisa resume t_ok", { userId: "u1" }));
    expect(sentAny(`恢复执行 · ${task.id}`)).toBe(true);
    expect(store.get(task.id)?.status).toBe("running");
  });

  test("没有凭据的旧任务恢复时按当前策略重校验", async () => {
    const cfg = makeCfg(repo, stateDir, { sources: { github: { accept: "off" } } });
    const task = seed({ id: "t_legacy", branch: "pisa/t_legacy" });
    mkdirSync(join(stateDir, "worktrees", task.id), { recursive: true });

    await build(cfg).handle(msg("/pisa resume t_legacy", { userId: "u1" }));
    expect(store.get(task.id)?.status).toBe("paused");
    expect(lastSent()).toContain("准入策略 未记录 → 当前");
  });

  test("/pisa policy 展示规则、版本与未结束任务的版本分布", async () => {
    const cfg = makeCfg(repo, stateDir, { sources: { github: { allowed: ["alice", "bob"] } } });
    const version = resolvePolicy(cfg).version;
    seed({ id: "t_waiting", status: "queued", policyVersion: version });

    await build(cfg).handle(msg("/pisa policy", { userId: "u9", channel: "fake" }));

    const text = lastSent();
    expect(text).toContain(`准入策略 · 版本 ${version}`);
    expect(text).toContain("名单=alice,bob");
    expect(text).toContain("内:@允许/未@拒绝");
    expect(text).toContain(`未结束任务按版本：${version} 1`);
  });
});

describe("策略版本", () => {
  const cfg = (policy?: PolicyConfig): Config =>
    makeCfg("/tmp/none", "/tmp/none", policy);

  test("内容相同写法不同也同版本", () => {
    const a = cfg({ sources: { github: { allowed: ["bob", "alice"] } } });
    const b = cfg({ sources: { github: { allowed: ["alice", "bob", "alice"] } } });
    expect(resolvePolicy(a).version).toBe(resolvePolicy(b).version);
  });

  test("改名单、准入格或接单方式都会换版本", () => {
    const version = (policy?: PolicyConfig) => resolvePolicy(cfg(policy)).version;
    const base = version();
    expect(version({ sources: { github: { allowed: ["alice"] } } })).not.toBe(base);
    expect(version({ sources: { github: { accept: "observe" } } })).not.toBe(base);
    expect(version({ sources: { github: { admit: { unlisted: { mentioned: "allow" } } } } })).not.toBe(base);
  });

  test("未知来源追加进表，缺省按基础准入表处理", () => {
    const policy = resolvePolicy(cfg({ sources: { webhook: { allowed: ["hook"] } } }));
    expect(policy.sources.webhook?.accept).toBe("auto");
    expect(policy.sources.webhook?.admit.listed.mentioned).toBe("allow");
    expect(policy.sources.wecom?.allowed).toEqual([]);
  });
});
