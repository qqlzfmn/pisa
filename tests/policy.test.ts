import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import type { Config } from "../src/config";
import type { ChannelAdapter, IncomingMessage, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh } from "../src/git";
import { decideAdmission, resolvePolicy, type PolicyConfig } from "../src/policy";

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
  const dir = mkdtempSync(join(tmpdir(), "pisa-policy-repo-"));
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
    stateDir,
    policy,
  };
}

const okWorker: WorkerRunner = {
  async run(_task, workdir): Promise<WorkerResult> {
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    return { ok: true, summary: "改了 out.txt", exitCode: 0 };
  },
};

describe("resolvePolicy", () => {
  test("cli 与 github 默认四格全放开，其余来源名单外默认关闭", () => {
    const p = resolvePolicy(undefined, ["u1"]);
    expect(p.sources.cli!.cells).toEqual({ listedMention: "auto", listedPlain: "auto", unlistedMention: "auto", unlistedPlain: "auto" });
    expect(p.sources.github!.cells.unlistedPlain).toBe("auto");
    expect(p.sources.telegram!.cells.listedPlain).toBe("auto");
    expect(p.sources.telegram!.cells.unlistedPlain).toBe("off");
    // 配置里出现的来源也进表；判定时未登记来源按最严处理
    expect(resolvePolicy({ sources: { "hook-x": { unlisted: "observe" } } }, ["u1"]).sources["hook-x"]!.cells.unlistedPlain).toBe("observe");
    expect(decideAdmission(p, { channel: "hook-y", userId: "u1" }).mode).toBe("auto");
    expect(decideAdmission(p, { channel: "hook-y", userId: "u9" }).mode).toBe("off");
  });

  test("版本只看名单与来源规则：名单顺序与重复不影响，内容变化才变", () => {
    const a = resolvePolicy(undefined, ["u1", "u2"]);
    const b = resolvePolicy(undefined, ["u2", "u1", "u1"]);
    const c = resolvePolicy(undefined, ["u1"]);
    expect(a.version).toBe(b.version);
    expect(a.version).not.toBe(c.version);
    expect(a.version).toMatch(/^v[0-9a-f]{12}$/);
  });

  test("来源关闭时所有格都是 off，reason 指出来源被关", () => {
    const p = resolvePolicy({ sources: { telegram: { allowed: false } } }, ["u1"]);
    const d = decideAdmission(p, { channel: "telegram", userId: "u1", mentioned: true });
    expect(d.mode).toBe("off");
    expect(d.cell).toBe("listedMention");
    expect(d.reason).toContain("来源已关闭");
    expect(d.reason).toContain(p.version);
  });
});

describe("准入策略", () => {
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

  function build() {
    return new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel });
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

  test("名单外且未 @：拒绝，不建任务，回复带版本", async () => {
    const router = build();
    await router.handle(msg("/pisa 修登录", { userId: "u9" }));

    expect(store.recentTasks()).toHaveLength(0);
    const text = channel.sent.at(-1)!.text;
    expect(text).toStartWith("无权限：");
    expect(text).toContain("unlistedPlain = off");
    expect(store.countAdmissions("off")).toBe(1);
  });

  test("名单内 @ 才能进：同一人未 @ 被挡", async () => {
    cfg.policy = { sources: { telegram: { listed: { mention: "auto", plain: "off" } } } };
    const router = build();

    await router.handle(msg("/pisa 未点名", { mentioned: false }));
    expect(store.recentTasks()).toHaveLength(0);

    await router.handle(msg("/pisa 点名了", { mentioned: true }));
    const task = store.recentTasks()[0]!;
    expect(task.mandate).toEqual({
      source: "telegram",
      actor: "u1",
      listed: true,
      mentioned: true,
      cell: "listedMention",
    });
    expect(task.policyVersion).toBe(resolvePolicy(cfg.policy, cfg.whitelist.users).version);
  });

  test("观察模式只留痕不建任务", async () => {
    cfg.policy = { sources: { telegram: { unlisted: "observe" } } };
    const router = build();

    await router.handle(msg("/pisa 试探", { userId: "u9" }));

    expect(store.recentTasks()).toHaveLength(0);
    expect(channel.sent.at(-1)!.text).toStartWith("已记录，未建任务（观察模式）：");
    expect(store.countAdmissions("observe")).toBe(1);
  });

  test("降权后恢复被拒，任务保持暂停", async () => {
    cfg.policy = { sources: { telegram: { listed: { mention: "auto", plain: "auto" } } } };
    const router = build();
    await router.handle(msg("/pisa 待办", { mentioned: true }));
    const task = store.recentTasks()[0]!;
    expect(store.claimQueued(task.id, Date.now(), `pisa/${task.id}`)).toBe(true);
    expect(store.transition(task.id, "paused")).toBe(true);
    mkdirSync(join(stateDir, "worktrees", task.id), { recursive: true });

    // 移出名单：旧任务不追改状态，但恢复等于重新开工
    cfg.whitelist.users = [];
    await router.handle(msg(`/pisa resume ${task.id}`, { mentioned: true }));

    const text = channel.sent.at(-1)!.text;
    expect(text).toStartWith(`恢复被拒 · ${task.id}`);
    expect(text).toContain("派活时 telegram · 名单内用户、@ 了本服务 · listedMention");
    expect(text).toContain(task.policyVersion!);
    expect(text).toContain("unlistedMention = off");
    expect(store.get(task.id)?.status).toBe("paused");
  });

  test("未降权时恢复放行，mandate 从库里读回", async () => {
    const router = build();
    await router.handle(msg("/pisa 待办", { mentioned: true }));
    const task = store.recentTasks()[0]!;
    expect(store.claimQueued(task.id, Date.now(), `pisa/${task.id}`)).toBe(true);
    expect(store.transition(task.id, "paused")).toBe(true);
    mkdirSync(join(stateDir, "worktrees", task.id), { recursive: true });

    await router.handle(msg(`/pisa resume ${task.id}`, { mentioned: true }));

    expect(channel.sent.at(-1)!.text).toContain(`开始执行 · ${task.id}`);

    // 等这一轮跑完再断言，避免测试结束时还有在途任务
    for (let i = 0; i < 100 && store.get(task.id)?.status === "running"; i += 1) await Bun.sleep(20);
    expect(store.get(task.id)?.status).toBe("succeeded");
    expect(store.get(task.id)?.mandate?.cell).toBe("listedMention");
  });

  test("/pisa policy 展示规则与版本，不建任务", async () => {
    const router = build();
    await router.handle(msg("/pisa policy"));

    const text = channel.sent.at(-1)!.text;
    expect(text).toContain(resolvePolicy(cfg.policy, cfg.whitelist.users).version);
    expect(text).toContain("telegram");
    expect(text).toContain("名单外");
    expect(store.recentTasks()).toHaveLength(0);
  });

  test("旧任务没有 mandate 也能复核：按 channel + requester 重判", () => {
    const p = resolvePolicy(undefined, []);
    const d = decideAdmission(p, { channel: "cron", userId: "robot" });
    expect(d.mode).toBe("off");
    expect(d.reason).toContain("unlistedPlain");
    expect(existsSync(stateDir)).toBe(true);
  });
});
