import { describe, expect, test } from "bun:test";
import { HUMAN_SLOTS, queueReason, slotCapacity, slotLimits, slotText, slotUsage } from "../src/slots";

describe("slotLimits", () => {
  test("缺省并发按 1 个工作槽，追问槽固定 1 个", () => {
    expect(slotLimits(undefined)).toEqual({ base: 1, extra: HUMAN_SLOTS });
  });

  test("工作槽跟随并发，追问槽不跟着涨", () => {
    const limits = slotLimits(3);
    expect(limits).toEqual({ base: 3, extra: 1 });
    expect(slotCapacity(limits)).toBe(4);
  });

  test("非法并发退化为 1 个工作槽", () => {
    expect(slotLimits(0).base).toBe(1);
    expect(slotLimits(-2).base).toBe(1);
  });
});

describe("slotUsage", () => {
  test("先占工作槽，超出部分才算追问槽", () => {
    const limits = slotLimits(2);
    expect(slotUsage(1, limits)).toEqual({ base: { used: 1, limit: 2 }, extra: { used: 0, limit: 1 } });
    expect(slotUsage(2, limits)).toEqual({ base: { used: 2, limit: 2 }, extra: { used: 0, limit: 1 } });
    expect(slotUsage(3, limits)).toEqual({ base: { used: 2, limit: 2 }, extra: { used: 1, limit: 1 } });
  });

  test("超出总容量时如实显示超额", () => {
    expect(slotUsage(4, slotLimits(2)).extra.used).toBe(2);
  });

  test("负数按 0 处理", () => {
    expect(slotUsage(-1, slotLimits(2)).base.used).toBe(0);
  });

  test("文案含两类槽位的占用与上限", () => {
    expect(slotText(slotUsage(3, slotLimits(2)))).toBe("工作 2/2 · 追问 +1/1");
    expect(slotText(slotUsage(0, slotLimits(1)))).toBe("工作 0/1 · 追问 +0/1");
  });
});

describe("queueReason", () => {
  test("工作槽有空位时不报原因", () => {
    expect(queueReason("auto", slotUsage(1, slotLimits(2)))).toBeNull();
    expect(queueReason("human", slotUsage(1, slotLimits(2)))).toBeNull();
  });

  test("工作槽满时新任务等空闲槽，追问还能进追问槽", () => {
    const usage = slotUsage(2, slotLimits(2));
    expect(queueReason("auto", usage)).toBe("工作槽位已满");
    expect(queueReason("human", usage)).toBeNull();
  });

  test("两类槽位都满时追问也排队", () => {
    const usage = slotUsage(3, slotLimits(2));
    expect(queueReason("human", usage)).toBe("追问槽位已满");
    expect(queueReason("auto", usage)).toBe("工作槽位已满");
  });
});
