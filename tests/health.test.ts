import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComponentHealth, OPS_EXIT, OpsWatch, checkOps, configProblems, formatOpsProblems, type HealthState } from "../src/health";
import type { Config } from "../src/config";
import type { HeartbeatSource } from "../src/status";
import { Store } from "../src/store";
import { GithubWatcher } from "../src/github-watcher";
import type { Runner } from "../src/github";
import type { IncomingMessage } from "../src/types";

function cfg(over: Partial<Config> = {}): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: "/nonexistent", baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir: ".pisa-test",
    ...over,
  };
}

/** 内存版 Store：健康检查只用到 meta 与 lastBeat */
function memStore(meta = new Map<string, string>()): HealthState & HeartbeatSource & { meta: Map<string, string> } {
  return {
    meta,
    getMeta: (key) => meta.get(key) ?? null,
    setMeta: (key, value) => void meta.set(key, value),
    deleteMeta: (key) => void meta.delete(key),
    metaByPrefix: (prefix) =>
      [...meta.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => ({ key, value })),
    lastBeat: () => {
      const raw = meta.get("heartbeat");
      if (raw === undefined) return null;
      const n = Number(raw);
      return Number.isSafeInteger(n) ? n : null;
    },
  };
}

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "pisa-health-repo-"));
  spawnSync("git", ["init", "-q", repo]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

const emptyEnv: Record<string, string | undefined> = {};

/** 读一条 meta JSON（部件记录或去重记录），按运行时形状收窄 */
function stored(raw: string | null): { message: string; at: number } {
  if (raw === null) throw new Error("缺少 meta 记录");
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || !("message" in value) || typeof value.message !== "string") {
    throw new Error(`meta 记录不是部件错误：${raw}`);
  }
  const at = "at" in value && typeof value.at === "number" ? value.at : 0;
  return { message: value.message, at };
}
const NOW = 1_700_000_000_000;

describe("checkOps 退出码", () => {
  test("心跳新鲜、配置完整：0", () => {
    const store = memStore(new Map([["heartbeat", String(NOW)]]));
    const report = checkOps(cfg({ repos: [{ alias: "demo", path: repo }] }), store, emptyEnv, NOW);
    expect(report).toEqual({ exitCode: OPS_EXIT.ok, problems: [] });
    expect(formatOpsProblems(report)).toBe("");
  });

  test("没有心跳：1，输出提示需重启", () => {
    const report = checkOps(cfg({ repos: [{ alias: "demo", path: repo }] }), memStore(), emptyEnv, NOW);
    expect(report.exitCode).toBe(OPS_EXIT.restart);
    expect(formatOpsProblems(report)).toContain("需重启：daemon 没有心跳记录");
  });

  test("心跳过期为需重启", () => {
    const store = memStore(new Map([["heartbeat", String(NOW - 60_000)]]));
    const report = checkOps(cfg({ repos: [{ alias: "demo", path: repo }] }), store, emptyEnv, NOW);
    expect(report.exitCode).toBe(OPS_EXIT.restart);
    expect(report.problems[0]!.detail).toBe("心跳已停 1m0s");
  });

  test("心跳新鲜但有部件错误：2，消息进入列表", () => {
    const store = memStore(
      new Map([
        ["heartbeat", String(NOW)],
        ["health:github", JSON.stringify({ message: "拉取 o/r 评论失败：HTTP 401", at: NOW - 1000 })],
      ]),
    );
    const report = checkOps(cfg({ repos: [{ alias: "demo", path: repo }] }), store, emptyEnv, NOW);
    expect(report.exitCode).toBe(OPS_EXIT.component);
    expect(report.problems).toEqual([{ level: "component", source: "github", detail: "拉取 o/r 评论失败：HTTP 401" }]);
    expect(formatOpsProblems(report)).toBe("部件错误：github 拉取 o/r 评论失败：HTTP 401");
  });

  test("仓库路径不是 git 仓库：3，且优先于需重启", () => {
    const report = checkOps(cfg(), memStore(), emptyEnv, NOW);
    expect(report.exitCode).toBe(OPS_EXIT.config);
    expect(report.problems.map((p) => p.source)).toContain("repo:demo");
    // 同一份报告里仍列出需重启，退出码只回答先做哪件事
    expect(report.problems.map((p) => p.level)).toEqual(["config", "restart"]);
  });
});

describe("configProblems", () => {
  const healthy = (over: Partial<Config> = {}): Config => cfg({ repos: [{ alias: "demo", path: repo }], ...over });

  test("仓库为空", () => {
    expect(configProblems(cfg({ repos: [] }), emptyEnv)).toEqual([{ source: "repos", detail: "没有任何仓库，任务无处落地" }]);
  });

  test("环境变量缺项：telegram、webhook、触发入口、github", () => {
    const config = healthy({
      channels: { cli: true, telegram: { enabled: true, tokenEnv: "TG_TOKEN" } },
      webhook: { enabled: true, port: 8799, tokenEnv: "HOOK_TOKEN", chatId: "c1", userId: "u1" },
      triggers: {
        githubActions: { enabled: true, secretEnv: "GH_SECRET" },
        feishu: { enabled: true, secretEnv: "FEISHU_SECRET" },
        wecom: { enabled: true, tokenEnv: "WECOM_TOKEN", aesKeyEnv: "WECOM_AES" },
        fileWatch: { enabled: true, paths: [] },
      },
      github: { enabled: true },
    });
    expect(configProblems(config, emptyEnv).map((p) => p.source)).toEqual([
      "channels.telegram",
      "webhook",
      "triggers.githubActions",
      "triggers.feishu",
      "triggers.wecom",
      "triggers.wecom",
      "triggers.fileWatch",
      "triggers.fileWatch",
      "github",
    ]);

    const env = {
      TG_TOKEN: "x",
      HOOK_TOKEN: "x",
      GH_SECRET: "x",
      FEISHU_SECRET: "x",
      WECOM_TOKEN: "x",
      WECOM_AES: "x",
      GH_TOKEN: "x",
    };
    expect(configProblems({ ...config, triggers: { ...config.triggers, chatId: "c1", userId: "u1" } }, env)).toEqual([]);
  });

  test("github 的 tokenEnv 指向的变量也算数", () => {
    const config = healthy({ github: { enabled: true, tokenEnv: "MY_GH" } });
    expect(configProblems(config, { MY_GH: "t" })).toEqual([]);
  });

  test("Web 控制台身份不在白名单", () => {
    const config = healthy({
      web: { enabled: true, port: 8787, tokenEnv: "WEB_TOKEN", userId: "u9", chatId: "web" },
    });
    expect(configProblems(config, emptyEnv)).toEqual([{ source: "web.userId", detail: "u9 不在 whitelist.users，页面派活会被拒绝" }]);
  });

  test("远程入口与空白名单：报一次 whitelist.users", () => {
    const config = healthy({ whitelist: { users: [], repos: ["demo"] }, channels: { cli: true, telegram: { enabled: true, tokenEnv: "TG_TOKEN" } } });
    expect(configProblems(config, { TG_TOKEN: "x" })).toEqual([
      { source: "whitelist.users", detail: "启用了远程入口，但白名单为空，所有请求都会被拒绝" },
    ]);
  });

  test("只跑 CLI 时空白名单不算问题", () => {
    expect(configProblems(healthy({ whitelist: { users: [], repos: [] } }), emptyEnv)).toEqual([]);
  });

  test("定时任务缺身份、cron 无法解析", () => {
    const config = healthy({
      schedules: [
        { id: "daily", cron: "0 9 * * *", prompt: "日报" },
        { id: "broken", cron: "每分钟", prompt: "坏的" },
        { id: "off", cron: "每分钟", prompt: "停用的", enabled: false },
      ],
    });
    expect(configProblems(config, emptyEnv)).toEqual([
      { source: "scheduler", detail: "有启用的定时任务，但缺少 scheduler.chatId / userId" },
      { source: "schedule:broken", detail: "cron 表达式无法解析：每分钟" },
    ]);
  });

  test("ops 开启但缺收件人", () => {
    const config = healthy({ ops: { enabled: true } });
    expect(configProblems(config, emptyEnv)).toEqual([
      { source: "ops", detail: "缺少 ops.chatId，巡检无法投递" },
      { source: "ops", detail: "缺少 ops.userId，巡检无法投递" },
    ]);
  });
});

describe("ComponentHealth", () => {
  test("同一消息不重写，变化才更新；ok 删除", () => {
    const store = memStore();
    const health = new ComponentHealth(store);
    health.fail("github", new Error("401 Unauthorized"));
    const first = stored(store.meta.get("health:github") ?? null);
    expect(first.message).toBe("401 Unauthorized");

    health.fail("github", new Error("401 Unauthorized"));
    expect(stored(store.meta.get("health:github") ?? null).at).toBe(first.at);

    health.fail("github", new Error("500 Internal"));
    expect(stored(store.meta.get("health:github") ?? null).message).toBe("500 Internal");

    health.ok("github");
    expect(store.meta.has("health:github")).toBe(false);
  });

  test("长消息截断到 300 字", () => {
    const store = memStore();
    new ComponentHealth(store).fail("gc", "x".repeat(500));
    expect(stored(store.meta.get("health:gc") ?? null).message).toHaveLength(300);
  });

  test("reset 清空所有部件记录，不碰其它 meta", () => {
    const store = memStore(new Map([["heartbeat", "1"], ["github:since:o/r", "t"]]));
    const health = new ComponentHealth(store);
    health.fail("gc", "boom");
    health.fail("triggers", "boom");
    health.reset();
    expect([...store.meta.keys()].sort()).toEqual(["github:since:o/r", "heartbeat"]);
  });
});

describe("OpsWatch 巡检", () => {
  function watch(store: HealthState & HeartbeatSource, got: IncomingMessage[], over: Partial<Config> = {}, clock = { now: NOW }) {
    const config = cfg({
      repos: [{ alias: "demo", path: repo }],
      ops: { enabled: true, chatId: "c1", userId: "u1" },
      ...over,
    });
    return {
      watch: new OpsWatch({ cfg: config, store, enqueue: (m) => void got.push(m), env: emptyEnv, now: () => clock.now }),
      config,
      clock,
    };
  }

  test("同一签名只开一单，恢复后清零，再出问题重新开单", () => {
    const store = memStore();
    const got: IncomingMessage[] = [];
    const { watch: ops, clock } = watch(store, got);

    expect(ops.tick().exitCode).toBe(OPS_EXIT.restart);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ channel: "proactive", chatId: "c1", userId: "u1", isDirect: true });
    expect(got[0]!.text).toContain("需重启：daemon");
    expect(got[0]!.text).toContain("处理：守护进程没有心跳");

    // 同一问题：静默
    ops.tick();
    expect(got).toHaveLength(1);

    // 恢复：状态清零，不投递
    store.setMeta("heartbeat", String(NOW));
    expect(ops.tick().exitCode).toBe(OPS_EXIT.ok);
    expect(store.meta.has("ops:alert")).toBe(false);
    expect(got).toHaveLength(1);

    // 再次出现：重新提醒（时刻已推进，eventId 与上一轮不同）
    store.deleteMeta("heartbeat");
    clock.now += 3_600_000;
    ops.tick();
    expect(got).toHaveLength(2);
    expect(got[1]!.eventId).not.toBe(got[0]!.eventId);
  });

  test("问题变化会重新开单", () => {
    const store = memStore(new Map([["heartbeat", String(NOW)]]));
    const got: IncomingMessage[] = [];
    const { watch: ops } = watch(store, got);

    store.setMeta("health:github", JSON.stringify({ message: "401", at: NOW }));
    ops.tick();
    store.setMeta("health:github", JSON.stringify({ message: "500", at: NOW }));
    ops.tick();
    expect(got).toHaveLength(2);
  });

  test("用 ops.prompt 覆盖默认提示", () => {
    const store = memStore();
    const got: IncomingMessage[] = [];
    watch(store, got, { ops: { enabled: true, chatId: "c1", userId: "u1", prompt: "按 runbook 处理" } }).watch.tick();
    expect(got[0]!.text.startsWith("按 runbook 处理")).toBe(true);
  });

  test("未启用或缺收件人时不启动，旧签名被清掉", () => {
    const got: IncomingMessage[] = [];
    watch(memStore(), got, { ops: { enabled: false } }).watch.start();
    watch(memStore(), got, { ops: { enabled: true } }).watch.start();
    expect(got).toHaveLength(0);

    const store = memStore(new Map([["ops:alert", JSON.stringify({ signature: "old", at: NOW })]]));
    watch(store, got, { ops: { enabled: false } }).watch.tick();
    expect(store.meta.has("ops:alert")).toBe(false);
    expect(got).toHaveLength(0);
  });

  test("enabled 时 start() 立刻巡检，按间隔继续，stop() 后不再跑", async () => {
    const store = memStore();
    const got: IncomingMessage[] = [];
    const config = cfg({ repos: [{ alias: "demo", path: repo }], ops: { enabled: true, chatId: "c1", userId: "u1" } });
    const ops = new OpsWatch({ cfg: config, store, enqueue: (m) => void got.push(m), env: emptyEnv, now: () => NOW, intervalMs: 10 });
    ops.start();
    expect(got).toHaveLength(1);

    // 问题变化后，下一轮巡检发现签名不同并再次开单
    store.setMeta("health:github", JSON.stringify({ message: "401", at: NOW }));
    await Bun.sleep(30);
    expect(got.length).toBeGreaterThanOrEqual(2);

    ops.stop();
    const seen = got.length;
    await Bun.sleep(30);
    expect(got).toHaveLength(seen);
  });
});

describe("GithubWatcher 部件记账", () => {
  test("轮询失败记 github，整轮成功后清零", async () => {
    const store = new Store(":memory:");
    const health = new ComponentHealth(store);
    let failing = true;
    const runner: Runner = (args) => {
      if (failing && (args[2] ?? "").includes("/issues/comments")) return { code: 1, out: "", err: "HTTP 401" };
      return { code: 0, out: "", err: "" };
    };
    const w = new GithubWatcher({
      cfg: cfg({ github: { enabled: true, repos: [{ repo: "o/r", chatId: "c1", userId: "u1" }] } }),
      store,
      enqueue: () => {},
      runner,
      health,
      now: () => NOW,
    });

    await w.poll();
    expect(stored(store.getMeta("health:github")).message).toContain("拉取 o/r 评论失败：HTTP 401");

    failing = false;
    await w.poll();
    expect(store.getMeta("health:github")).toBeNull();
    store.close();
  });
});
