import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import type { Config } from "../src/config";
import type { ChannelAdapter, IncomingMessage, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh, createWorktree } from "../src/git";
import { admit, formatPolicy, isMentioned, policyFingerprint, policyVersion, sourceView } from "../src/policy";

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
  const dir = mkdtempSync(join(tmpdir(), "pisa-policy-repo-"));
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
    policy: { sources: {} },
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

describe("admit", () => {
  const base: Config = {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    policy: { sources: {} },
    stateDir: "/tmp/unused",
  };

  test("缺省策略与改动前一致：名单内通过，名单外拒绝", () => {
    const listed = admit(base, { source: "telegram", requester: "u1", mentioned: false });
    expect(listed.ok).toBe(true);
    expect(listed.mode).toBe("auto");

    const guest = admit(base, { source: "telegram", requester: "u9", mentioned: true });
    expect(guest.ok).toBe(false);
    expect(guest.reason).toBe("无权限：该用户不在白名单。");
  });

  test("四格：requireMention 与 allowGuests 各自只影响对应格子", () => {
    const strict: Config = {
      ...base,
      policy: { sources: { telegram: { requireMention: true, allowGuests: true } } },
    };
    const cells = sourceView(strict, "telegram").cells;
    expect(cells).toEqual({ listedMentioned: true, listedPlain: false, guestMentioned: true, guestPlain: false });

    expect(admit(strict, { source: "telegram", requester: "u1", mentioned: true }).ok).toBe(true);
    const plain = admit(strict, { source: "telegram", requester: "u1", mentioned: false });
    expect(plain.ok).toBe(false);
    expect(plain.reason).toContain("要求 @");
    expect(admit(strict, { source: "telegram", requester: "u9", mentioned: true }).ok).toBe(true);
    const guestPlain = admit(strict, { source: "telegram", requester: "u9", mentioned: false });
    expect(guestPlain.ok).toBe(false);
    expect(guestPlain.reason).toContain("不在白名单");
  });

  test("来源总闸与 accept 模式", () => {
    const off: Config = { ...base, policy: { sources: { github: { allowed: false }, webhook: { accept: "off" } } } };
    const closed = admit(off, { source: "github", requester: "u1", mentioned: true });
    expect(closed.ok).toBe(false);
    expect(closed.reason).toContain("github");
    expect(admit(off, { source: "webhook", requester: "u1", mentioned: true }).ok).toBe(false);

    const observe: Config = { ...base, policy: { sources: { webhook: { accept: "observe" } } } };
    const seen = admit(observe, { source: "webhook", requester: "u1", mentioned: true });
    expect(seen.ok).toBe(true);
    expect(seen.mode).toBe("observe");
  });

  test("规则指纹随白名单与来源规则变化，显式 version 优先", () => {
    const before = policyFingerprint(base);
    expect(policyVersion(base)).toBe(before);
    expect(policyFingerprint({ ...base, whitelist: { ...base.whitelist, users: ["u1", "u2"] } })).not.toBe(before);
    expect(
      policyFingerprint({ ...base, policy: { sources: { telegram: { requireMention: true } } } }),
    ).not.toBe(before);

    const labeled: Config = { ...base, policy: { version: "3", sources: {} } };
    expect(policyVersion(labeled)).toBe("3");
    expect(policyFingerprint(labeled)).toBe(before);
  });

  test("@ 信号：群聊看正文，私聊与程序化入口视为已 @", () => {
    expect(isMentioned({ channel: "telegram" })).toBe(false);
    expect(isMentioned({ channel: "telegram", isDirect: true })).toBe(true);
    expect(isMentioned({ channel: "telegram", isDirect: true, mentioned: false })).toBe(false);
    for (const channel of ["webhook", "web", "github", "cron", "proactive"]) {
      expect(isMentioned({ channel })).toBe(true);
    }
  });

  test("formatPolicy 列出每个已知来源与版本", () => {
    const text = formatPolicy(base);
    for (const name of ["telegram", "webhook", "github", "cron"]) expect(text).toContain(name);
    expect(text).toContain(policyVersion(base));
    expect(text).toContain("指纹");
  });
});

describe("Router 准入", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-policy-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
    cfg = makeCfg(repo, stateDir);
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function build(worker: WorkerRunner = okWorker) {
    return new Router({ cfg, store, worker, deliverer: new GitDeliverer(cfg), channel });
  }

  test("非白名单用户被拒，且不占 eventId", async () => {
    const router = build();
    const evt = msg("/pisa 修一下登录", { userId: "u9" });
    await router.handle(evt);

    expect(store.recentTasks()).toHaveLength(0);
    expect(channel.sent[0]!.text).toContain("无权限：该用户不在白名单。");

    // 同一 eventId 换个白名单用户重发：被拒的投递没有占位
    await router.handle({ ...evt, userId: "u1" });
    expect(store.recentTasks()).toHaveLength(1);
  });

  test("telegram requireMention：不带 @ 被拒，带 @ 通过", async () => {
    cfg.policy = { sources: { telegram: { requireMention: true } } };
    const router = build();

    await router.handle(msg("/pisa 修一下登录", { channel: "telegram" }));
    expect(store.recentTasks()).toHaveLength(0);
    expect(channel.sent.at(-1)!.text).toContain("要求 @");

    await router.handle(msg("/pisa 修一下登录", { channel: "telegram", mentioned: true }));
    expect(store.recentTasks()).toHaveLength(1);
    expect(store.recentTasks()[0]!.mandate).toEqual({
      source: "telegram",
      requester: "u1",
      actor: "u1",
      mentioned: true,
    });
  });

  test("telegram allowGuests：名单外只在被 @ 时放行", async () => {
    cfg.policy = { sources: { telegram: { allowGuests: true } } };
    const router = build();

    await router.handle(msg("/pisa 修一下登录", { channel: "telegram", userId: "u9" }));
    expect(store.recentTasks()).toHaveLength(0);
    expect(channel.sent.at(-1)!.text).toContain("不在白名单");

    await router.handle(msg("/pisa 修一下登录", { channel: "telegram", userId: "u9", mentioned: true }));
    expect(store.recentTasks()).toHaveLength(1);
    expect(store.recentTasks()[0]!.requester).toBe("u9");
  });

  test("observe 只登记不派活，重复投递只记一条", async () => {
    cfg.policy = { version: "7", sources: { webhook: { accept: "observe" } } };
    const router = build();

    const evt = msg("/pisa 修一下登录", { channel: "webhook", eventId: "hook-1", messageKey: "hook-1", isDirect: true });
    await router.handle(evt);
    await router.handle(evt);

    expect(store.recentTasks()).toHaveLength(0);
    const records = store.recentAdmissions();
    expect(records).toHaveLength(1);
    expect(records[0]!.source).toBe("webhook");
    expect(records[0]!.policyVersion).toBe("7");
    expect(channel.sent.filter((s) => s.text.includes("observe"))).toHaveLength(1);
    expect(channel.sent.at(-1)!.text).toContain("只登记不派活");
  });

  test("来源关闭与 accept=off 的提示带来源名", async () => {
    cfg.policy = { sources: { github: { allowed: false }, cron: { accept: "off" } } };
    const router = build();

    await router.handle(msg("/pisa 修一下登录", { channel: "github", mentioned: true }));
    expect(channel.sent.at(-1)!.text).toContain("来源 github");

    // 拒绝提示按人 24 小时节流；换一个 Router 才能看到第二条
    await build().handle(msg("/pisa 修一下登录", { channel: "cron" }));
    expect(channel.sent.at(-1)!.text).toContain("来源 cron");
    expect(store.recentTasks()).toHaveLength(0);
  });

  test("任务记录 mandate 与策略版本", async () => {
    cfg.policy = { version: "2", sources: {} };
    const router = build();
    await router.handle(msg("/pisa 修一下登录", { channel: "telegram", actor: "alice", mentioned: true }));

    const task = store.recentTasks()[0]!;
    expect(task.policyVersion).toBe("2");
    expect(task.mandate).toEqual({ source: "telegram", requester: "u1", actor: "alice", mentioned: true });
  });

  test("/pisa policy 展示规则与版本，非白名单用户被拒", async () => {
    cfg.policy = { version: "5", sources: { telegram: { requireMention: true } } };
    const router = build();

    await router.handle(msg("/pisa policy"));
    const text = channel.sent.at(-1)!.text;
    expect(text).toContain("来源准入 · 版本 5");
    expect(text).toContain("telegram · 总闸开 · auto");
    expect(text).toContain("名单内：@ 允许 · 不 @ 拒绝");

    await router.handle(msg("/policy", { isDirect: true }));
    expect(channel.sent.at(-1)!.text).toContain("来源准入 · 版本 5");

    await router.handle(msg("/pisa policy", { userId: "u9" }));
    expect(channel.sent.at(-1)!.text).toContain("不在白名单");
  });

  test("降权后 resume 被拒并说明版本，提权后可恢复", async () => {
    cfg.policy = { version: "1", sources: {} };
    const router = build();
    await router.handle(msg("/pisa 待办"));
    const task = store.recentTasks()[0]!;
    const workdir = join(stateDir, "worktrees", task.id);
    expect(store.claimQueued(task.id, Date.now(), `pisa/${task.id}`)).toBe(true);
    expect(createWorktree(repo, workdir, `pisa/${task.id}`).code).toBe(0);
    store.setSessionId(task.id, "sess-1");
    expect(store.transition(task.id, "paused")).toBe(true);

    cfg.whitelist.users = [];
    cfg.policy = { version: "2", sources: {} };
    await router.handle(msg(`/pisa resume ${task.id}`));

    const rejected = channel.sent.at(-1)!.text;
    expect(rejected).toContain(`拒绝恢复 · ${task.id}`);
    expect(rejected).toContain("不在白名单");
    expect(rejected).toContain("任务记录的策略版本：1；当前：2");
    expect(store.get(task.id)?.status).toBe("paused");

    cfg.whitelist.users = ["u1"];
    await router.handle(msg(`/pisa resume ${task.id}`));
    expect(channel.sent.some((s) => s.text.includes(`恢复执行 · ${task.id}`))).toBe(true);
    await router.drainOnce();
    expect(store.get(task.id)?.status).toBe("succeeded");
  });

  test("来源改成 observe 后 resume 被拒", async () => {
    cfg.policy = { version: "1", sources: {} };
    const router = build();
    await router.handle(msg("/pisa 待办", { channel: "telegram", mentioned: true }));
    const task = store.recentTasks()[0]!;
    const workdir = join(stateDir, "worktrees", task.id);
    expect(store.claimQueued(task.id, Date.now(), `pisa/${task.id}`)).toBe(true);
    expect(createWorktree(repo, workdir, `pisa/${task.id}`).code).toBe(0);
    expect(store.transition(task.id, "paused")).toBe(true);

    cfg.policy = { version: "2", sources: { telegram: { accept: "observe" } } };
    await router.handle(msg(`/pisa resume ${task.id}`));
    expect(channel.sent.at(-1)!.text).toContain("observe");
    expect(store.get(task.id)?.status).toBe("paused");
  });

  test("仓库被移出白名单后 resume 被拒", async () => {
    const router = build();
    await router.handle(msg("/pisa 待办"));
    const task = store.recentTasks()[0]!;
    const workdir = join(stateDir, "worktrees", task.id);
    expect(store.claimQueued(task.id, Date.now(), `pisa/${task.id}`)).toBe(true);
    expect(createWorktree(repo, workdir, `pisa/${task.id}`).code).toBe(0);
    expect(store.transition(task.id, "paused")).toBe(true);

    cfg.whitelist.repos = [];
    await router.handle(msg(`/pisa resume ${task.id}`));
    expect(channel.sent.at(-1)!.text).toContain("已不在白名单");
    expect(store.get(task.id)?.status).toBe("paused");
  });
});
