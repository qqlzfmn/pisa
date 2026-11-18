import { describe, expect, test } from "bun:test";
import { Proactive } from "../src/proactive";
import type { Config } from "../src/config";
import type { IncomingMessage } from "../src/types";

function cfg(over: Partial<Config> = {}): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    api: { enabled: false, port: 0 },
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
