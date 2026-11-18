import { describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { EffectQueue, effectBackoff } from "../src/effects";

/** 推送类 payload 的最小样例 */
function pushPayload(taskId = "t1") {
  return { taskId, repoPath: "/repo", branch: `pisa/${taskId}` };
}

describe("effectBackoff", () => {
  test("2s 起逐次翻倍，60s 封顶", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(effectBackoff)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  });
});

describe("EffectQueue", () => {
  test("同一 (kind, key) 只执行一次，第二次拿到首次结果", async () => {
    const store = new Store(":memory:");
    const queue = new EffectQueue(store, { now: () => 1000 });
    let runs = 0;
    queue.register("push", async () => {
      runs += 1;
      return null;
    });

    await queue.exec("push", "k", "t1", pushPayload());
    const again = await queue.exec("push", "k", "t1", pushPayload());

    expect(runs).toBe(1);
    expect(again).toBeNull();
    expect(store.effectRow("push", "k")?.status).toBe("done");
    store.close();
  });

  test("同一行执行中再遇到不跑第二遍", async () => {
    const store = new Store(":memory:");
    const queue = new EffectQueue(store, { now: () => 1_000 });
    let runs = 0;
    const gate = Promise.withResolvers<void>();
    queue.register("push", async () => {
      runs += 1;
      await gate.promise;
      return null;
    });
    store.enqueueEffect({ kind: "push", key: "k", taskId: "t1", payload: JSON.stringify(pushPayload()), at: 0 });

    const first = queue.exec("push", "k", "t1", pushPayload());
    // 执行中：后台 flush 跳过这一行，等不到第二个动作
    expect(await queue.flush()).toEqual({ done: 0, failed: 0 });
    gate.resolve();
    await first;

    expect(runs).toBe(1);
    expect(store.effectRow("push", "k")?.status).toBe("done");
    store.close();
  });

  test("flush 排队期间同一行已被 exec 完成时不再执行第二遍", async () => {
    const store = new Store(":memory:");
    const queue = new EffectQueue(store, { now: () => 1_000, onError: () => {} });
    const runs: string[] = [];
    const gate = Promise.withResolvers<void>();
    queue.register("push", async (p) => {
      runs.push(p.taskId);
      if (p.taskId === "t1") await gate.promise;
      return null;
    });
    const payload = (taskId: string) => ({ taskId, repoPath: "/repo", branch: `pisa/${taskId}` });
    store.enqueueEffect({ kind: "push", key: "a", taskId: "t1", payload: JSON.stringify(payload("t1")), at: 0 });
    store.enqueueEffect({ kind: "push", key: "b", taskId: "t2", payload: JSON.stringify(payload("t2")), at: 0 });

    const flushing = queue.flush();
    // 第一行卡在 handler 里时，第二行被 exec 直接完成；flush 的快照里它仍是 pending
    await queue.exec("push", "b", "t2", payload("t2"));
    gate.resolve();
    await flushing;

    expect(runs).toEqual(["t1", "t2"]);
    expect(store.effectRow("push", "b")?.status).toBe("done");
    store.close();
  });

  test("失败后留在库里，2s 退避，到期才重试", async () => {
    const store = new Store(":memory:");
    let clock = 1_000;
    const queue = new EffectQueue(store, { now: () => clock, onError: () => {} });
    let fail = true;
    let runs = 0;
    queue.register("push", async () => {
      runs += 1;
      if (fail) throw new Error("网络断开");
      return null;
    });

    await expect(queue.exec("push", "k", "t1", pushPayload())).rejects.toThrow("网络断开");
    const row = store.effectRow("push", "k")!;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.nextAt).toBe(clock + 2000);
    expect(row.lastError).toBe("网络断开");

    // 未到期不执行
    expect(await queue.flush()).toEqual({ done: 0, failed: 0 });
    expect(runs).toBe(1);

    fail = false;
    clock += 2000;
    expect(await queue.flush()).toEqual({ done: 1, failed: 0 });
    expect(runs).toBe(2);
    expect(store.effectRow("push", "k")?.status).toBe("done");
    store.close();
  });

  test("连续失败 10 次后终止，不再重试", async () => {
    const store = new Store(":memory:");
    let clock = 1_000;
    const queue = new EffectQueue(store, { now: () => clock, onError: () => {} });
    let runs = 0;
    queue.register("push", async () => {
      runs += 1;
      throw new Error("一直失败");
    });

    await expect(queue.exec("push", "k", "t1", pushPayload())).rejects.toThrow("一直失败");
    for (let i = 0; i < 20; i += 1) {
      clock += 60_000;
      await queue.flush();
    }

    const row = store.effectRow("push", "k")!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(10);
    expect(runs).toBe(10);
    await expect(queue.exec("push", "k", "t1", pushPayload())).rejects.toThrow("已终止");
    store.close();
  });

  test("重启后新队列继续执行未完成的行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-effects-"));
    const dbPath = join(dir, "pisa.db");
    let clock = 1_000;
    try {
      const before = new Store(dbPath);
      const first = new EffectQueue(before, { now: () => clock, onError: () => {} });
      first.register("push", async () => {
        throw new Error("进程被杀前最后一次尝试");
      });
      await expect(first.exec("push", "k", "t1", pushPayload())).rejects.toThrow();
      before.close();

      const after = new Store(dbPath);
      let runs = 0;
      const second = new EffectQueue(after, { now: () => clock });
      second.register("push", async () => {
        runs += 1;
        return null;
      });
      clock += 2000;
      expect(await second.flush()).toEqual({ done: 1, failed: 0 });
      expect(runs).toBe(1);
      expect(after.effectRow("push", "k")?.status).toBe("done");
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cancelTask 丢弃未完成的行，已完成的行保留", async () => {
    const store = new Store(":memory:");
    const queue = new EffectQueue(store, { now: () => 1_000 });
    store.enqueueEffect({ kind: "push", key: "a", taskId: "t1", payload: "{}", at: 0 });
    store.enqueueEffect({ kind: "push", key: "b", taskId: "t1", payload: "{}", at: 0 });
    store.completeEffect("push", "b", null, 0);
    store.enqueueEffect({ kind: "push", key: "c", taskId: "t2", payload: "{}", at: 0 });

    expect(queue.cancelTask("t1")).toBe(1);
    expect(store.effectRow("push", "a")).toBeNull();
    expect(store.effectRow("push", "b")?.status).toBe("done");
    expect(store.effectRow("push", "c")?.status).toBe("pending");
    store.close();
  });

  test("start 立即重放未完成的行，stop 后定时器不再触发", async () => {
    vi.useFakeTimers();
    try {
      const store = new Store(":memory:");
      const queue = new EffectQueue(store, { now: () => 1_000 });
      let runs = 0;
      const { promise, resolve } = Promise.withResolvers<void>();
      queue.register("push", async () => {
        runs += 1;
        resolve();
        return null;
      });
      store.enqueueEffect({ kind: "push", key: "k", taskId: "t1", payload: JSON.stringify(pushPayload()), at: 0 });

      queue.start(10);
      await promise;
      queue.stop();
      expect(store.effectRow("push", "k")?.status).toBe("done");

      store.enqueueEffect({ kind: "push", key: "k2", taskId: "t1", payload: JSON.stringify(pushPayload()), at: 0 });
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      expect(runs).toBe(1);
      expect(store.effectRow("push", "k2")?.status).toBe("pending");
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
