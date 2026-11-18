import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { OPS_META_KEY, opsHealth, patrolTick } from "../src/ops";
import { Store } from "../src/store";

let dir: string;
let store: Store;

function cfg(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    stateDir: dir,
    repos: [{ alias: "demo", path: "/tmp/demo", baseBranch: "main" }],
    whitelist: { users: [], repos: ["demo"] },
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pisa-ops-"));
  store = new Store(join(dir, "pisa.db"));
  store.beat();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("opsHealth 四种退出码", () => {
  test("0 正常：仓库已配、心跳新鲜、没有启用的部件", () => {
    const health = opsHealth({ cfg: cfg(), store, env: {} });
    expect(health).toEqual({ code: 0, level: "ok", issues: [] });
  });

  test("1 需重启：没有心跳记录", () => {
    const fresh = new Store(join(dir, "cold.db"));
    try {
      const health = opsHealth({ cfg: cfg(), store: fresh, env: {} });
      expect(health.code).toBe(1);
      expect(health.level).toBe("restart");
      expect(health.issues[0]!.message).toContain("无心跳记录");
    } finally {
      fresh.close();
    }
  });

  test("1 需重启：心跳过期", () => {
    const health = opsHealth({ cfg: cfg(), store, env: {}, now: Date.now() + 60_000 });
    expect(health.code).toBe(1);
    expect(health.issues[0]!.message).toContain("最后心跳");
  });

  test("2 部件错误：Telegram 启用但缺 token", () => {
    const health = opsHealth({
      cfg: cfg({ channels: { telegram: { enabled: true, tokenEnv: "PISA_TELEGRAM_TOKEN" } } }),
      store,
      env: {},
    });
    expect(health.code).toBe(2);
    expect(health.issues.map((i) => i.key)).toEqual(["component:telegram-token"]);
  });

  test("2 部件错误：cron 非法、id 重复、GitHub 无归属", () => {
    const health = opsHealth({
      cfg: cfg({
        github: { enabled: true, repos: [] },
        scheduler: { chatId: "c", userId: "u" },
        schedules: [
          { id: "a", cron: "bad", prompt: "p", enabled: true },
          { id: "a", cron: "0 * * * *", prompt: "p", enabled: true },
        ],
      }),
      store,
      env: {},
    });
    expect(health.code).toBe(2);
    expect(health.issues.map((i) => i.key)).toEqual([
      "component:github-repos",
      "component:schedule-cron:a",
      "component:schedule-duplicate:a",
    ]);
  });

  test("3 待配置：没有仓库，且优先于部件与心跳问题", () => {
    const health = opsHealth({
      cfg: cfg({
        repos: [],
        channels: { telegram: { enabled: true, tokenEnv: "PISA_TELEGRAM_TOKEN" } },
      }),
      store,
      env: {},
      now: Date.now() + 60_000,
    });
    expect(health.code).toBe(3);
    expect(health.level).toBe("config");
    expect(health.issues.map((i) => i.key)).toContain("config:repos");
  });
});

describe("patrolTick 去重与恢复", () => {
  test("同一问题只提醒一次，恢复后清零，再出现重新提醒", async () => {
    const cold = opsHealth({ cfg: cfg(), store: new Store(join(dir, "cold.db")), env: {} });
    expect(cold.code).toBe(1);
    const dead = new Store(join(dir, "dead.db"));
    try {
      const sent: string[] = [];
      const first = await patrolTick({ cfg: cfg(), store: dead, env: {}, send: (t) => void sent.push(t) });
      expect(first.fresh.map((i) => i.key)).toEqual(["daemon:heartbeat"]);
      expect(first.delivered).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("守护进程未运行");
      expect(dead.getMeta(OPS_META_KEY)).toBe("daemon:heartbeat");

      const second = await patrolTick({ cfg: cfg(), store: dead, env: {}, send: (t) => void sent.push(t) });
      expect(second.fresh).toEqual([]);
      expect(sent).toHaveLength(1);

      dead.beat();
      const recovered = await patrolTick({ cfg: cfg(), store: dead, env: {}, send: (t) => void sent.push(t) });
      expect(recovered.health.code).toBe(0);
      expect(dead.getMeta(OPS_META_KEY)).toBe("");

      const again = await patrolTick({ cfg: cfg(), store: dead, env: {}, now: Date.now() + 60_000 });
      expect(again.fresh.map((i) => i.key)).toEqual(["daemon:heartbeat"]);
      expect(again.delivered).toBe(false);
    } finally {
      dead.close();
    }
  });

  test("投递失败不写去重记录，下一轮重试", async () => {
    const dead = new Store(join(dir, "dead.db"));
    try {
      const failed = await patrolTick({
        cfg: cfg(),
        store: dead,
        env: {},
        send: () => {
          throw new Error("network down");
        },
      });
      expect(failed.error).toBe("network down");
      expect(failed.delivered).toBe(false);
      expect(dead.getMeta(OPS_META_KEY)).toBeNull();

      let calls = 0;
      const retried = await patrolTick({ cfg: cfg(), store: dead, env: {}, send: () => void (calls += 1) });
      expect(retried.delivered).toBe(true);
      expect(calls).toBe(1);
      expect(dead.getMeta(OPS_META_KEY)).toBe("daemon:heartbeat");
    } finally {
      dead.close();
    }
  });
});
