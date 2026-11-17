import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { Proactive } from "../src/proactive";
import type { Config } from "../src/config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { decide, effectivePolicy, POLICY_SOURCES, sourceOf, type AcceptMode, type PolicyConfig } from "../src/policy";
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

/** 只把「名单外 + @」换成指定模式的策略；其余格沿用默认 */
function unlistedMentionPolicy(mode: AcceptMode): PolicyConfig {
  return {
    sources: {
      im: {
        admission: [
          { listed: true, mentioned: true, mode: "auto" },
          { listed: true, mentioned: false, mode: "auto" },
          { listed: false, mentioned: true, mode },
          { listed: false, mentioned: false, mode: "off" },
        ],
      },
    },
  };
}

const neverRun: WorkerRunner = {
  async run(): Promise<WorkerResult> {
    throw new Error("准入测试不应执行 worker");
  },
};

describe("准入策略", () => {
  test("默认表：名单内放行，名单外拒绝", () => {
    const policy = effectivePolicy();
    for (const source of POLICY_SOURCES) expect(policy.sources[source].allowed).toBe(true);
    expect(decide(policy, { source: "im", listed: true, mentioned: true }).mode).toBe("auto");
    expect(decide(policy, { source: "im", listed: true, mentioned: false }).mode).toBe("auto");
    expect(decide(policy, { source: "im", listed: false, mentioned: true }).mode).toBe("off");
    expect(decide(policy, { source: "im", listed: false, mentioned: false }).mode).toBe("off");
  });

  test("来源关闭后一律拒绝", () => {
    const policy = effectivePolicy({ sources: { webhook: { allowed: false } } });
    const decision = decide(policy, { source: "webhook", listed: true, mentioned: true });
    expect(decision.mode).toBe("off");
    expect(decision.reason).toContain("已禁用");
  });

  test("准入格缺失按 off 处理", () => {
    const policy = effectivePolicy({
      sources: { im: { admission: [{ listed: false, mentioned: true, mode: "auto" }] } },
    });
    expect(decide(policy, { source: "im", listed: false, mentioned: true }).mode).toBe("auto");
    expect(decide(policy, { source: "im", listed: true, mentioned: true }).mode).toBe("off");
  });

  test("版本随规则变化，显式版本优先", () => {
    const base = effectivePolicy();
    expect(effectivePolicy().version).toBe(base.version);
    const changed = effectivePolicy(unlistedMentionPolicy("observe"));
    expect(changed.version).not.toBe(base.version);
    expect(effectivePolicy({ version: "v9" }).version).toBe("v9");
  });

  test("非法配置直接报错", () => {
    expect(() =>
      effectivePolicy({
        sources: {
          im: {
            admission: [
              { listed: true, mentioned: true, mode: "auto" },
              { listed: true, mentioned: true, mode: "off" },
            ],
          },
        },
      }),
    ).toThrow("重复格");
    const bad = { sources: { nope: {} } } as unknown as PolicyConfig;
    expect(() => effectivePolicy(bad)).toThrow("未知来源");
  });

  test("字段拼错或类型不对时不落回默认表", () => {
    // 拼错 admission：静默忽略会放宽到默认表（名单内 auto），必须报错
    expect(() =>
      effectivePolicy({ sources: { im: { admisson: [{ listed: true, mentioned: true, mode: "off" }] } } as never }),
    ).toThrow("未知字段");
    expect(() => effectivePolicy({ policys: {} } as never)).toThrow("未知字段");
    expect(() => effectivePolicy({ sources: { im: { allowed: null } } } as never)).toThrow("allowed 必须是布尔值");
    expect(() => effectivePolicy({ sources: "off" } as never)).toThrow("sources 必须是对象");
    expect(() => effectivePolicy({ sources: { im: "off" } } as never)).toThrow("必须是对象");
  });

  test("通道映射到来源", () => {
    expect(sourceOf("telegram")).toBe("im");
    expect(sourceOf("cli")).toBe("im");
    expect(sourceOf("fake")).toBe("im");
    expect(sourceOf("github")).toBe("github");
    expect(sourceOf("webhook")).toBe("webhook");
    expect(sourceOf("cron")).toBe("cron");
    expect(sourceOf("proactive")).toBe("proactive");
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

  function build(): Router {
    return new Router({ cfg, store, worker: neverRun, deliverer: new GitDeliverer(cfg), channel });
  }

  function seedPaused(id: string): Task {
    mkdirSync(join(stateDir, "worktrees", id), { recursive: true });
    const task: Task = {
      id,
      source: "seed",
      channel: "fake",
      chatId: "c1",
      requester: "u1",
      repo: "demo",
      prompt: "做到一半",
      status: "paused",
      branch: `pisa/${id}`,
      prUrl: null,
      sessionId: "sess",
      baseRef: null,
      context: null,
      replyPr: null,
      replyIssue: null,
      replyRepo: null,
      mandate: { source: "im", channel: "fake", listed: true, mentioned: true, mode: "auto" },
      policyVersion: effectivePolicy().version,
      summary: null,
      error: null,
      createdAt: 0,
      startedAt: 0,
      endedAt: null,
      cancelRequested: false,
    };
    store.insertTask(task);
    return task;
  }

  test("默认策略：名单内用户建任务并记录 mandate 与版本", async () => {
    const router = build();
    await router.handle(msg("/pisa 修登录"));

    const task = store.recentTasks()[0]!;
    expect(task.mandate).toEqual({ source: "im", channel: "fake", listed: true, mentioned: true, mode: "auto" });
    expect(task.policyVersion).toBe(effectivePolicy().version);
    expect(channel.sent.at(-1)?.text).toContain("已接单");
  });

  test("群聊关键词转发按「未 @」落格，不冒充点名", async () => {
    cfg.proactive = { keywords: { enabled: true, words: ["挂了"], cooldownSec: 600 } };
    const router = build();
    let pending: Promise<void> | undefined;
    new Proactive(cfg, (m) => {
      pending = router.handle(m);
    }).observe({
      eventId: "tg-1",
      channel: "telegram",
      chatId: "g1",
      userId: "u1",
      text: "支付挂了",
      isDirect: false,
    });
    await pending;

    expect(store.recentTasks()[0]!.mandate?.mentioned).toBe(false);
  });

  test("群聊关键词转发的消息同样受准入格约束", async () => {
    cfg.proactive = { keywords: { enabled: true, words: ["挂了"], cooldownSec: 600 } };
    cfg.policy = {
      sources: {
        im: {
          admission: [
            { listed: true, mentioned: true, mode: "auto" },
            { listed: true, mentioned: false, mode: "observe" },
            { listed: false, mentioned: true, mode: "off" },
            { listed: false, mentioned: false, mode: "off" },
          ],
        },
      },
    };
    const router = build();
    let pending: Promise<void> | undefined;
    new Proactive(cfg, (m) => {
      pending = router.handle(m);
    }).observe({
      eventId: "tg-2",
      channel: "telegram",
      chatId: "g1",
      userId: "u1",
      text: "支付挂了",
      isDirect: false,
    });
    await pending;

    expect(store.recentTasks()).toHaveLength(0);
    expect(channel.sent.at(-1)?.text).toContain("不执行");
  });

  test("越权：名单外用户被拒，不建任务", async () => {
    const router = build();
    await router.handle(msg("/pisa 修登录", { userId: "u2" }));

    expect(store.recentTasks()).toHaveLength(0);
    expect(channel.sent.at(-1)?.text).toContain("无权限");
  });

  test("名单内未 @ 仍按默认表放行", async () => {
    const router = build();
    await router.handle(msg("/pisa 修登录", { mentioned: false }));

    expect(store.recentTasks()).toHaveLength(1);
    expect(store.recentTasks()[0]!.mandate?.mentioned).toBe(false);
  });

  test("越权：名单外未 @ 被拒，不建任务", async () => {
    const router = build();
    await router.handle(msg("/pisa 修登录", { userId: "u2", mentioned: false }));

    expect(store.recentTasks()).toHaveLength(0);
    expect(channel.sent.at(-1)?.text).toContain("名单外");
  });

  test("observe：名单外 @ 只记录不执行", async () => {
    cfg.policy = unlistedMentionPolicy("observe");
    const router = build();
    await router.handle(msg("/pisa 修登录", { userId: "u2" }));

    expect(store.recentTasks()).toHaveLength(0);
    const text = channel.sent.at(-1)?.text ?? "";
    expect(text).toContain("observe");
    expect(text).toContain("不执行");
  });

  test("auto：名单外 @ 可建任务并记录来源事实", async () => {
    cfg.policy = unlistedMentionPolicy("auto");
    const router = build();
    await router.handle(msg("/pisa 修登录", { userId: "u2" }));

    const task = store.recentTasks()[0]!;
    expect(task.mandate).toEqual({ source: "im", channel: "fake", listed: false, mentioned: true, mode: "auto" });
    expect(task.policyVersion).toBe(effectivePolicy(cfg.policy).version);
  });

  test("降权：移出白名单后新请求被拒，既有任务不受影响", async () => {
    const router = build();
    await router.handle(msg("/pisa 修登录"));
    const before = store.recentTasks()[0]!;

    cfg.whitelist.users = [];
    await router.handle(msg("/pisa 再修一次"));

    expect(store.recentTasks()).toHaveLength(1);
    expect(store.get(before.id)?.status).toBe("queued");
    expect(channel.sent.at(-1)?.text).toContain("无权限");
  });

  test("恢复前重校验：降权后拒绝恢复并保持暂停", async () => {
    const task = seedPaused("t_paused_1");
    cfg.whitelist.users = [];
    const router = build();

    await router.handle(msg(`/pisa resume ${task.id}`));

    expect(store.get(task.id)?.status).toBe("paused");
    const text = channel.sent.at(-1)?.text ?? "";
    expect(text).toContain("拒绝恢复");
    expect(text).toContain(effectivePolicy().version);
    expect(text).toContain("名单外");
  });

  test("/pisa policy 展示版本与各来源规则", async () => {
    const router = build();
    await router.handle(msg("/pisa policy"));

    const text = channel.sent.at(-1)?.text ?? "";
    expect(text).toContain(effectivePolicy().version);
    for (const source of POLICY_SOURCES) expect(text).toContain(source);
    expect(text).toContain("名单内@ auto");
  });
});
