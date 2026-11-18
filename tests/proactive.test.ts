import { describe, expect, test } from "bun:test";
import { Proactive } from "../src/proactive";
import type { Config } from "../src/config";
import type { IncomingMessage } from "../src/types";

function cfg(over: Partial<Config> = {}): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [],
    worker: { adapter: "omp", command: "omp", timeoutSec: 60, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir: ".pisa-test",
    ...over,
  };
}

function m(text: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return { eventId: `e-${Math.random()}`, channel: "telegram", chatId: "g1", userId: "u9", text, isDirect: false, ...over };
}

describe("主动发现", () => {
  test("群里命中关键词就开单，冷却期内不重复", async () => {
    const got: IncomingMessage[] = [];
    const p = new Proactive(
      cfg({ proactive: { keywords: { enabled: true, words: ["挂了", "报错"], cooldownSec: 600 } } }),
      (msg) => void got.push(msg),
    );
    p.observe(m("线上支付挂了，谁看下"));
    p.observe(m("又报错了"));
    expect(got.length).toBe(1);
    expect(got[0]!.text).toContain("线上支付挂了");
    expect(got[0]!.userId).toBe("u1");
  });

  test("私聊与带触发词的消息不走关键词", () => {
    const got: IncomingMessage[] = [];
    const p = new Proactive(
      cfg({ proactive: { keywords: { enabled: true, words: ["挂了"] } } }),
      (msg) => void got.push(msg),
    );
    p.observe(m("挂了", { isDirect: true }));
    p.observe(m("/pisa 挂了就修"));
    expect(got.length).toBe(0);
  });

  test("探针签名与冷却落 meta：重启不重复开单，换签名或过冷却才再开", async () => {
    const got: IncomingMessage[] = [];
    const meta = new Map<string, string>();
    const store = {
      getMeta: (k: string) => meta.get(k) ?? null,
      setMeta: (k: string, v: string) => void meta.set(k, v),
    };
    let out = "ci failed";
    let now = 1_000_000;
    const probeCfg = cfg({
      proactive: {
        probe: { enabled: true, command: "gh run list", intervalSec: 3600, cooldownSec: 1800, chatId: "c1", userId: "u1" },
      },
    });
    // 每次 start() 视为一次进程重启：新实例共享同一份 meta
    const boot = () => {
      const p = new Proactive(probeCfg, (m) => void got.push(m), { meta: store, now: () => now, runProbe: () => ({ code: 1, out }) });
      p.start();
      p.stop();
    };

    boot();
    boot();
    expect(got.length).toBe(1);
    const key = [...meta.keys()].find((k) => k.startsWith("probe:"));
    expect(key).toBeDefined();
    expect(JSON.parse(meta.get(key!)!)).toEqual({ signature: "1:ci failed", firedAt: 1_000_000 });

    out = "ci failed: timeout";
    boot();
    expect(got.length).toBe(2);

    boot();
    expect(got.length).toBe(2);
    now += 1800 * 1000;
    boot();
    expect(got.length).toBe(3);
  });

  test("eventId 由签名与冷却窗口推导：窗口内重复被跳过，跨窗口换新 id", () => {
    const meta = new Map<string, string>();
    const store = {
      getMeta: (k: string) => meta.get(k) ?? null,
      setMeta: (k: string, v: string) => void meta.set(k, v),
    };
    const got: IncomingMessage[] = [];
    let now = 0;
    const p = () =>
      new Proactive(
        cfg({
          proactive: { probe: { enabled: true, command: "curl -f localhost:1", intervalSec: 3600, cooldownSec: 60, chatId: "c1", userId: "u1" } },
        }),
        (m) => void got.push(m),
        { meta: store, now: () => now, runProbe: () => ({ code: 7, out: "refused" }) },
      );
    const first = p();
    first.start();
    first.stop();
    const early = got[0]!.eventId;
    expect(early).toMatch(/^proactive:probe:[0-9a-f]{12}:[0-9a-f]{40}:0$/);
    now = 30_000;
    const again = p();
    again.start();
    again.stop();
    expect(got.length).toBe(1);
    now = 60_000;
    const restart = p();
    restart.start();
    restart.stop();
    expect(got.length).toBe(2);
    expect(got[1]!.eventId).not.toBe(early);
    expect(got[1]!.eventId.endsWith(":1")).toBe(true);
  });

  test("探针失败开单，成功不开单", async () => {
    const got: IncomingMessage[] = [];
    const bad = new Proactive(
      cfg({
        proactive: {
          probe: { enabled: true, command: "echo boom >&2; exit 3", intervalSec: 3600, chatId: "c1", userId: "u1" },
        },
      }),
      (msg) => void got.push(msg),
    );
    bad.start();
    bad.stop();
    expect(got.length).toBe(1);
    expect(got[0]!.text).toContain("退出码：3");
    expect(got[0]!.text).toContain("boom");

    const okGot: IncomingMessage[] = [];
    const good = new Proactive(
      cfg({
        proactive: { probe: { enabled: true, command: "true", intervalSec: 3600, chatId: "c1", userId: "u1" } },
      }),
      (msg) => void okGot.push(msg),
    );
    good.start();
    good.stop();
    expect(okGot.length).toBe(0);
  });
});
