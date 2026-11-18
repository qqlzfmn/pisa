import { describe, expect, test } from "bun:test";
import { Proactive, type ProbeResult, type ProbeState } from "../src/proactive";
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

function memState(): { meta: Map<string, string>; state: ProbeState } {
  const meta = new Map<string, string>();
  return { meta, state: { getMeta: (key) => meta.get(key) ?? null, setMeta: (key, value) => void meta.set(key, value) } };
}

type ProbeConf = NonNullable<NonNullable<Config["proactive"]>["probe"]>;

function probeCfg(over: Partial<ProbeConf> = {}): Config {
  return cfg({
    proactive: {
      probe: { enabled: true, command: "ci", intervalSec: 3600, cooldownSec: 600, chatId: "c1", userId: "u1", ...over },
    },
  });
}

/** 一次进程启动：start() 立即跑一轮探针，stop() 收掉定时器 */
function boot(config: Config, got: IncomingMessage[], deps: { store: ProbeState; now: () => number; runProbe: () => ProbeResult }): void {
  const p = new Proactive(config, (msg) => void got.push(msg), deps);
  p.start();
  p.stop();
}

describe("主动发现", () => {
  test("群里命中关键词就开单，冷却期内不重复", () => {
    const got: IncomingMessage[] = [];
    const p = new Proactive(
      cfg({ proactive: { keywords: { enabled: true, words: ["挂了", "报错"], cooldownSec: 600 } } }),
      (msg) => void got.push(msg),
      { store: memState().state },
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
      { store: memState().state },
    );
    p.observe(m("挂了", { isDirect: true }));
    p.observe(m("/pisa 挂了就修"));
    expect(got.length).toBe(0);
  });

  test("探针失败开单，成功不开单", () => {
    const got: IncomingMessage[] = [];
    const bad = new Proactive(
      probeCfg({ command: "echo boom >&2; exit 3" }),
      (msg) => void got.push(msg),
      { store: memState().state },
    );
    bad.start();
    bad.stop();
    expect(got.length).toBe(1);
    expect(got[0]!.text).toContain("退出码：3");
    expect(got[0]!.text).toContain("boom");

    const okGot: IncomingMessage[] = [];
    const good = new Proactive(probeCfg({ command: "true" }), (msg) => void okGot.push(msg), {
      store: memState().state,
    });
    good.start();
    good.stop();
    expect(okGot.length).toBe(0);
  });

  test("崩溃重启后同一故障在冷却窗口内只开一单", () => {
    const got: IncomingMessage[] = [];
    const { meta, state } = memState();
    const now = 1_700_000_000_000;
    const deps = { store: state, now: () => now, runProbe: () => ({ code: 1, output: "CI failed: lint\n" }) };
    const config = probeCfg({ command: "gh run list --limit 1" });

    boot(config, got, deps);
    boot(config, got, deps);

    expect(got.length).toBe(1);
    const entry = [...meta.entries()].find(([key]) => key.startsWith("probe:"));
    expect(entry).toBeDefined();
    expect(JSON.parse(entry![1])).toEqual({ signature: "1:CI failed: lint", firedAt: now });
    expect(got[0]!.eventId).toMatch(
      new RegExp(`^proactive:probe:${entry![0].slice("probe:".length)}:[0-9a-f]{40}:${Math.floor(now / 600_000)}$`),
    );
  });

  test("输出签名变化立即再开一单", () => {
    const got: IncomingMessage[] = [];
    const { state } = memState();
    let output = "CI failed: lint";
    const deps = { store: state, now: () => 1_700_000_000_000, runProbe: () => ({ code: 1, output }) };
    const config = probeCfg();

    boot(config, got, deps);
    output = "CI failed: test";
    boot(config, got, deps);

    expect(got.length).toBe(2);
    expect(got[0]!.eventId).not.toBe(got[1]!.eventId);
    expect(got[1]!.text).toContain("CI failed: test");
  });

  test("冷却结束后同签名进入新窗口才再开单", () => {
    const got: IncomingMessage[] = [];
    const { state } = memState();
    let now = 1_700_000_000_000;
    const deps = { store: state, now: () => now, runProbe: () => ({ code: 1, output: "boom" }) };
    const config = probeCfg();

    boot(config, got, deps);
    now += 600_000;
    boot(config, got, deps);

    expect(got.length).toBe(2);
    const windowOf = (eventId: string) => Number(eventId.split(":")[4]);
    expect(windowOf(got[1]!.eventId)).toBe(windowOf(got[0]!.eventId) + 1);
  });
});
