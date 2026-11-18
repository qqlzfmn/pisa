import { describe, expect, test } from "bun:test";
import { Slots, canLaneClaim, queueReason, usageFromTasks, type SlotLimits } from "../src/slots";
import type { Lane } from "../src/types";

function lanes(...items: Array<[string, Lane]>) {
  return items.map(([id, lane]) => ({ id, lane }));
}

describe("Slots", () => {
  test("基础槽位满时只有 human 车道还能进", () => {
    const slots = new Slots({ base: 1, human: 1 });
    slots.claim("a", "base");

    expect(slots.canClaim("base")).toBe(false);
    expect(slots.canClaim("human")).toBe(true);

    slots.claim("b", "human");
    expect(slots.canClaim("human")).toBe(false);
    expect(slots.usage()).toEqual({
      limits: { base: 1, human: 1 },
      base: { used: 1, limit: 1 },
      human: { used: 1, limit: 1 },
      used: 2,
      capacity: 2,
    });
  });

  test("备用槽位为 0 时两条车道等价", () => {
    const slots = new Slots({ base: 1, human: 0 });
    slots.claim("a", "base");

    expect(slots.canClaim("base")).toBe(false);
    expect(slots.canClaim("human")).toBe(false);
  });

  test("释放后基础槽位可再占用", () => {
    const slots = new Slots({ base: 2, human: 1 });
    slots.claim("a", "base");
    slots.claim("b", "base");
    expect(slots.canClaim("base")).toBe(false);

    slots.release("a");
    expect(slots.canClaim("base")).toBe(true);
  });

  test("超出车道容量时直接抛错", () => {
    const slots = new Slots({ base: 1, human: 0 });
    slots.claim("a", "base");
    expect(() => slots.claim("b", "human")).toThrow("槽位已满：human 车道 1/1");
  });
});

describe("槽位快照与排队原因", () => {
  const limits: SlotLimits = { base: 2, human: 1 };

  test("单独跑着的 human 任务不占基础槽位", () => {
    const usage = usageFromTasks(lanes(["a", "human"]), limits);
    expect(usage.base.used).toBe(0);
    expect(usage.human.used).toBe(1);
    expect(canLaneClaim("base", usage)).toBe(true);
    expect(canLaneClaim("human", usage)).toBe(true);
  });

  test("从在跑任务还原占用，human 显示超出基础槽位的部分", () => {
    const usage = usageFromTasks(lanes(["a", "base"], ["b", "base"], ["c", "human"]), limits);
    expect(usage.base).toEqual({ used: 2, limit: 2 });
    expect(usage.human).toEqual({ used: 1, limit: 1 });
    expect(canLaneClaim("base", usage)).toBe(false);
    expect(canLaneClaim("human", usage)).toBe(false);
  });

  test("base 车道在基础槽位满时即被拦截", () => {
    const usage = usageFromTasks(lanes(["a", "base"], ["b", "base"]), limits);
    expect(canLaneClaim("base", usage)).toBe(false);
    expect(canLaneClaim("human", usage)).toBe(true);
  });

  test("排队原因按车道说明等的是什么", () => {
    const usage = usageFromTasks(lanes(["a", "base"], ["b", "base"], ["c", "human"]), limits);
    expect(queueReason("base", usage)).toBe("等槽位（基础 2/2 已满）");
    expect(queueReason("human", usage)).toBe("等槽位（3/3 已满，含备用）");
  });
});
