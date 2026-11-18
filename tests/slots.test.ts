import { describe, expect, test } from "bun:test";
import type { TaskStatus } from "../src/types";
import { formatSlots, HUMAN_SLOTS, queueReason, slotLimits, slotUsage } from "../src/slots";

const item = (lane: "human" | "worker", status: TaskStatus) => ({ lane, status });

describe("slotLimits", () => {
  test("worker 跟随并发配置，最小为 1", () => {
    expect(slotLimits(undefined).worker).toBe(1);
    expect(slotLimits(0).worker).toBe(1);
    expect(slotLimits(3).worker).toBe(3);
  });

  test("追问通道固定 1 个槽位，不随并发变化", () => {
    expect(slotLimits(undefined).human).toBe(HUMAN_SLOTS);
    expect(slotLimits(8).human).toBe(HUMAN_SLOTS);
  });
});

describe("slotUsage", () => {
  test("按通道统计运行与排队，忽略其他状态", () => {
    const usage = slotUsage(
      [item("worker", "running"), item("worker", "queued"), item("human", "queued"), item("worker", "succeeded")],
      2,
    );
    expect(usage).toEqual({
      limits: { human: 1, worker: 2 },
      running: { human: 0, worker: 1 },
      queued: { human: 1, worker: 1 },
    });
  });
});

describe("queueReason", () => {
  test("槽位满就说在等哪条通道，未满则即将开始", () => {
    const full = slotUsage([item("worker", "running"), item("human", "running")], 1);
    expect(queueReason("worker", full)).toBe("等 worker 槽位");
    expect(queueReason("human", full)).toBe("等追问槽位");

    const free = slotUsage([], 1);
    expect(queueReason("worker", free)).toBe("即将开始");
    expect(queueReason("human", free)).toBe("即将开始");
  });
});

describe("formatSlots", () => {
  test("展示两条通道的占用与总排队数", () => {
    const usage = slotUsage([item("worker", "running"), item("worker", "queued"), item("human", "queued")], 2);
    expect(formatSlots(usage)).toBe("槽位：worker 1/2 · 追问 0/1 · 排队 2");
  });

  test("没有排队时不带排队后缀", () => {
    expect(formatSlots(slotUsage([], 2))).toBe("槽位：worker 0/2 · 追问 0/1");
  });
});
