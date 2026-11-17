import { describe, expect, test } from "bun:test";
import { Store } from "../src/store";
import { EffectQueue, type EffectRunner } from "../src/effects";

/** 假时钟：退避只记录不等待，测试不耗真实时间 */
function clock(start = 1_000_000) {
  const waits: number[] = [];
  let now = start;
  return {
    waits,
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
}

/** 排空已排队的微任务：重放是后台执行的，断言前让出一轮 */
async function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
}

describe("EffectQueue", () => {
  test("同一 (kind, key) 并发入队只执行一次，两次拿到同一结果", async () => {
    const store = new Store(":memory:");
    const c = clock();
    const gate = Promise.withResolvers<void>();
    let runs = 0;
    const runner: EffectRunner = async () => {
      runs += 1;
      await gate.promise;
      return "https://github.com/o/r/pull/1";
    };
    const queue = new EffectQueue(store, runner, { now: c.now, sleep: c.sleep });

    const a = queue.enqueue("pr", "demo:main", { head: "main" });
    const b = queue.enqueue("pr", "demo:main", { head: "main" });
    gate.resolve();
    const [first, second] = await Promise.all([a, b]);

    expect(runs).toBe(1);
    expect(first).toEqual({ ok: true, result: "https://github.com/o/r/pull/1" });
    expect(second).toEqual(first);
    const row = store.effectJob("pr", "demo:main")!;
    expect(row.status).toBe("done");
    expect(row.result).toBe("https://github.com/o/r/pull/1");
    store.close();
  });

  test("已完成的行再次入队不执行动作，直接复用结果", async () => {
    const store = new Store(":memory:");
    const c = clock();
    let runs = 0;
    const queue = new EffectQueue(
      store,
      async () => {
        runs += 1;
        return "posted";
      },
      { now: c.now, sleep: c.sleep },
    );

    const first = await queue.enqueue("comment", "o/r#7:t1", { body: "hi" });
    const second = await queue.enqueue("comment", "o/r#7:t1", { body: "hi" });

    expect(runs).toBe(1);
    expect(second).toEqual(first);
    store.close();
  });

  test("不同 key 各自执行", async () => {
    const store = new Store(":memory:");
    const c = clock();
    const seen: string[] = [];
    const queue = new EffectQueue(
      store,
      async (job) => {
        seen.push(job.dedupeKey);
        return null;
      },
      { now: c.now, sleep: c.sleep },
    );

    await queue.enqueue("push", "demo:main:aaa", {});
    await queue.enqueue("push", "demo:main:bbb", {});

    expect(seen).toEqual(["demo:main:aaa", "demo:main:bbb"]);
    store.close();
  });

  test("失败按 2s→60s 退避，次数用尽标 failed", async () => {
    const store = new Store(":memory:");
    const c = clock();
    let runs = 0;
    const queue = new EffectQueue(
      store,
      async () => {
        runs += 1;
        throw new Error("gh: rate limited");
      },
      { now: c.now, sleep: c.sleep },
    );

    const outcome = await queue.enqueue("push", "demo:main:ccc", {});

    expect(runs).toBe(7);
    expect(c.waits).toEqual([2000, 4000, 8000, 16000, 32000, 60000]);
    expect(outcome).toEqual({ ok: false, error: "gh: rate limited" });
    const row = store.effectJob("push", "demo:main:ccc")!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("gh: rate limited");
    store.close();
  });

  test("中途成功则停止重试并落 done", async () => {
    const store = new Store(":memory:");
    const c = clock();
    let runs = 0;
    const queue = new EffectQueue(
      store,
      async () => {
        runs += 1;
        if (runs < 3) throw new Error("网络抖动");
        return "ok";
      },
      { now: c.now, sleep: c.sleep },
    );

    const outcome = await queue.enqueue("pr", "demo:x", {});

    expect(outcome).toEqual({ ok: true, result: "ok" });
    expect(c.waits).toEqual([2000, 4000]);
    expect(store.effectJob("pr", "demo:x")!.status).toBe("done");
    store.close();
  });

  test("重启后重放上次进程留下的未完成 effect", async () => {
    const store = new Store(":memory:");
    const c = clock();
    // 上次进程：已落库、失败过一次、还没重试完就退出了
    const leftover = store.enqueueEffect("pr", "demo:restart", { head: "pisa/t1" }, c.now());
    store.deferEffect(leftover.id, 1, c.now() + 2000, "gh down", c.now());

    let runs = 0;
    const restarted = new EffectQueue(
      store,
      async () => {
        runs += 1;
        return "https://github.com/o/r/pull/9";
      },
      { now: c.now, sleep: c.sleep },
    );

    expect(restarted.replay()).toBe(1);
    // 重放不阻塞启动：让出微任务后动作已跑完
    await flush();
    expect(store.effectJob("pr", "demo:restart")!.status).toBe("done");
    expect(runs).toBe(1);
    expect(c.waits).toEqual([2000]);
    expect(store.effectJob("pr", "demo:restart")!.result).toBe("https://github.com/o/r/pull/9");
    store.close();
  });

  test("关停后入队不执行，行保持 pending 等下次重放", async () => {
    const store = new Store(":memory:");
    const c = clock();
    let runs = 0;
    const queue = new EffectQueue(
      store,
      async () => {
        runs += 1;
        return null;
      },
      { now: c.now, sleep: c.sleep },
    );
    queue.stop();

    const outcome = await queue.enqueue("comment", "o/r#3:t9", {});
    expect(outcome.ok).toBe(false);
    expect(runs).toBe(0);
    expect(store.effectJob("comment", "o/r#3:t9")!.status).toBe("pending");
    expect(queue.replay()).toBe(0);
    store.close();
  });

  test("退避等待被 stop 打断，动作保持 pending", async () => {
    const store = new Store(":memory:");
    const c = clock();
    const firstRun = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let runs = 0;
    const queue = new EffectQueue(
      store,
      async () => {
        runs += 1;
        firstRun.resolve();
        throw new Error("boom");
      },
      { now: c.now, sleep: () => gate.promise },
    );

    const pending = queue.enqueue("push", "demo:main:ddd", {});
    await firstRun.promise;
    queue.stop();
    gate.resolve();

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(runs).toBe(1);
    expect(store.effectJob("push", "demo:main:ddd")!.status).toBe("pending");
    store.close();
  });
});
