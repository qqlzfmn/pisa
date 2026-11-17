import { describe, expect, test } from "bun:test";
import { matches, parseCron, Scheduler } from "../src/scheduler";
import { Store } from "../src/store";
import type { Config, ScheduleJob } from "../src/config";
import type { IncomingMessage } from "../src/types";

function cfg(over: Partial<Config> = {}): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [],
    worker: { adapter: "omp", command: "omp", timeoutSec: 60, verifyTimeoutSec: 600, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    scheduler: { chatId: "c1", userId: "u1" },
    stateDir: ".pisa-test",
    ...over,
  };
}

/** 本地时间，避免时区影响 */
const at = (y: number, m: number, d: number, h: number, min: number): Date => new Date(y, m - 1, d, h, min, 0);

function makeScheduler(jobs: ScheduleJob[], over: Partial<Config> = {}) {
  const got: IncomingMessage[] = [];
  const store = new Store(":memory:");
  const s = new Scheduler({ cfg: cfg({ schedules: jobs, ...over }), store, enqueue: (m) => void got.push(m) });
  return { got, store, s };
}

describe("cron 解析", () => {
  test("每分钟", () => {
    const m = parseCron("* * * * *")!;
    expect(m(at(2026, 1, 5, 9, 0))).toBe(true);
    expect(m(at(2026, 1, 5, 13, 47))).toBe(true);
  });

  test("工作日 9 点", () => {
    const m = parseCron("0 9 * * 1-5")!;
    expect(m(at(2026, 1, 5, 9, 0))).toBe(true); // 周一
    expect(m(at(2026, 1, 5, 9, 1))).toBe(false);
    expect(m(at(2026, 1, 4, 9, 0))).toBe(false); // 周日
  });

  test("每 15 分钟", () => {
    const m = parseCron("*/15 * * * *")!;
    for (const min of [0, 15, 30, 45]) expect(m(at(2026, 1, 5, 10, min))).toBe(true);
    expect(m(at(2026, 1, 5, 10, 7))).toBe(false);
  });

  test("每月 1 号零点", () => {
    const m = parseCron("0 0 1 * *")!;
    expect(m(at(2026, 1, 1, 0, 0))).toBe(true);
    expect(m(at(2026, 1, 2, 0, 0))).toBe(false);
  });

  test("周日写 7 也命中", () => {
    const m = parseCron("0 9 * * 7")!;
    expect(m(at(2026, 1, 4, 9, 0))).toBe(true);
    expect(m(at(2026, 1, 5, 9, 0))).toBe(false);
  });

  test("逗号列表与区间步长", () => {
    const m = parseCron("1,3 8-10/2 * * *")!;
    expect(m(at(2026, 1, 5, 8, 1))).toBe(true);
    expect(m(at(2026, 1, 5, 10, 3))).toBe(true);
    expect(m(at(2026, 1, 5, 9, 1))).toBe(false);
    expect(m(at(2026, 1, 5, 8, 5))).toBe(false);
  });

  test("非法表达式返回 null，matches 不命中", () => {
    for (const expr of ["* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "0 0 0 * *", "0 0 * 13 *", "a b c d e", "*/0 * * * *", "5-1 * * * *", "5/2 * * * *", ""]) {
      expect(parseCron(expr)).toBeNull();
      expect(matches(expr, at(2026, 1, 5, 9, 0))).toBe(false);
    }
  });
});

describe("定时任务调度", () => {
  test("同一分钟只投一次，下一分钟再投", async () => {
    const { got, store, s } = makeScheduler([{ id: "every", cron: "* * * * *", prompt: "巡检" }]);
    await s.tick(at(2026, 1, 5, 9, 0));
    await s.tick(new Date(2026, 0, 5, 9, 0, 42));
    expect(got.length).toBe(1);
    expect(got[0]!.eventId).toBe("cron:every:2026-01-05T09:00");
    expect(got[0]!.channel).toBe("cron");
    expect(got[0]!.chatId).toBe("c1");
    expect(got[0]!.userId).toBe("u1");
    expect(got[0]!.text).toBe("巡检");

    await s.tick(at(2026, 1, 5, 9, 1));
    expect(got.length).toBe(2);
    store.close();
  });

  test("禁用与未命中的 job 不投", async () => {
    const { got, store, s } = makeScheduler([
      { id: "off", cron: "* * * * *", prompt: "停用", enabled: false },
      { id: "mismatch", cron: "0 3 * * *", prompt: "凌晨" },
    ]);
    await s.tick(at(2026, 1, 5, 9, 0));
    expect(got.length).toBe(0);
    store.close();
  });

  test("repo 透传", async () => {
    const { got, store, s } = makeScheduler([{ id: "r", cron: "* * * * *", prompt: "p", repo: "family" }]);
    await s.tick(at(2026, 1, 5, 9, 0));
    expect(got[0]!.repo).toBe("family");
    store.close();
  });

  test("非法 cron 与重复 id 只告警跳过，其他 job 照常", async () => {
    const { got, store, s } = makeScheduler([
      { id: "bad", cron: "* * * *", prompt: "坏的" },
      { id: "dup", cron: "* * * * *", prompt: "第一次" },
      { id: "dup", cron: "* * * * *", prompt: "第二次" },
      { id: "ok", cron: "* * * * *", prompt: "好的" },
    ]);
    await s.tick(at(2026, 1, 5, 9, 0));
    expect(got.map((m) => m.text)).toEqual(["第一次", "好的"]);
    store.close();
  });

  test("缺少 scheduler 身份时不投", async () => {
    const { got, store, s } = makeScheduler([{ id: "x", cron: "* * * * *", prompt: "p" }], { scheduler: undefined });
    s.start();
    s.stop();
    await s.tick(at(2026, 1, 5, 9, 0));
    expect(got.length).toBe(0);
    store.close();
  });
});
