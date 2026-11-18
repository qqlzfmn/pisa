import { describe, expect, test } from "bun:test";
import { Proactive, type ProbeDeps } from "../src/proactive";
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

/** 进程内替身：meta 与 events 共用一份状态，两个 Proactive 实例相当于同一进程的两次启动 */
function memoryDeps(): {
  deps: ProbeDeps;
  meta: Map<string, string>;
  events: Set<string>;
  setNow: (at: number) => void;
  setOutput: (out: string) => void;
} {
  const meta = new Map<string, string>();
  const events = new Set<string>();
  let now = 1_700_000_000_000;
  let output = "boom";
  return {
    meta,
    events,
    setNow: (at) => void (now = at),
    setOutput: (out) => void (output = out),
    deps: {
      load: (key) => meta.get(key) ?? null,
      save: (key, value) => void meta.set(key, value),
      claim: (eventId) => {
        if (events.has(eventId)) return false;
        events.add(eventId);
        return true;
      },
      now: () => now,
      run: () => ({ code: 1, out: output }),
    },
  };
}

describe("主动发现", () => {
  test("群里命中关键词就开单，冷却期内不重复", async () => {
    const got: IncomingMessage[] = [];
    const p = new Proactive(
      cfg({ proactive: { keywords: { enabled: true, words: ["挂了", "报错"], cooldownSec: 600 } } }),
      (msg) => void got.push(msg),
      memoryDeps().deps,
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
      memoryDeps().deps,
    );
    p.observe(m("挂了", { isDirect: true }));
    p.observe(m("/pisa 挂了就修"));
    expect(got.length).toBe(0);
  });

  test("探针失败开单，成功不开单", async () => {
    const got: IncomingMessage[] = [];
    const realDeps = memoryDeps();
    realDeps.deps.run = undefined;
    const bad = new Proactive(
      cfg({
        proactive: {
          probe: { enabled: true, command: "echo boom >&2; exit 3", intervalSec: 3600, chatId: "c1", userId: "u1" },
        },
      }),
      (msg) => void got.push(msg),
      realDeps.deps,
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
      realDeps.deps,
    );
    good.start();
    good.stop();
    expect(okGot.length).toBe(0);
  });

  test("重启后同一故障在冷却窗口内只开一张单", () => {
    const got: IncomingMessage[] = [];
    const state = memoryDeps();
    const probe = cfg({
      proactive: {
        probe: { enabled: true, command: "ci-check", intervalSec: 3600, cooldownSec: 1800, chatId: "c1", userId: "u1" },
      },
    });
    const start = () => {
      const p = new Proactive(probe, (msg) => void got.push(msg), state.deps);
      p.start();
      p.stop();
    };

    start();
    expect(got.length).toBe(1);
    const [metaKey] = [...state.meta.keys()];
    expect(metaKey).toMatch(/^probe:[0-9a-f]{8}$/);
    expect(JSON.parse(state.meta.get(metaKey!)!)).toEqual({ signature: "1:boom", firedAt: 1_700_000_000_000 });
    expect(got[0]!.eventId).toMatch(/^proactive:probe:[0-9a-f]{8}:[0-9a-f]{40}:\d+$/);

    // 进程重启：同一个签名、还在冷却内
    start();
    expect(got.length).toBe(1);

    // 输出变了就是另一个故障，立刻开单
    state.setOutput("boom-2");
    start();
    expect(got.length).toBe(2);

    // 跨过冷却窗口后，同签名允许再开一单
    state.setNow(1_700_000_000_000 + 1_800_000);
    start();
    expect(got.length).toBe(3);
    expect(new Set(got.map((msg) => msg.eventId)).size).toBe(3);
  });

  test("事件已被占位时不再开单", () => {
    const got: IncomingMessage[] = [];
    const state = memoryDeps();
    state.deps.claim = () => false;
    const p = new Proactive(
      cfg({
        proactive: {
          probe: { enabled: true, command: "ci-check", intervalSec: 3600, cooldownSec: 1800, chatId: "c1", userId: "u1" },
        },
      }),
      (msg) => void got.push(msg),
      state.deps,
    );
    p.start();
    p.stop();
    expect(got.length).toBe(0);
    expect(state.meta.size).toBe(0);
  });
});
