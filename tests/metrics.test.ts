import { afterEach, describe, expect, test } from "bun:test";
import { Store } from "../src/store";
import type { Task, TaskStatus } from "../src/types";
import { computeWindowMetrics, METRICS_WINDOW_MS, percentile, windowMetrics } from "../src/metrics";

function task(id: string, status: TaskStatus, startedAt: number | null, endedAt: number | null): Task {
  return {
    id,
    source: `seed:${id}`,
    channel: "test",
    chatId: "test",
    requester: "u1",
    repo: "demo",
    prompt: "样本",
    status,
    branch: null,
    prUrl: null,
    sessionId: null,
    baseRef: null,
    context: null,
    replyPr: null,
    replyIssue: null,
    replyRepo: null,
    summary: null,
    error: null,
    createdAt: startedAt ?? endedAt ?? 0,
    startedAt,
    endedAt,
    lane: "base",
    cancelRequested: false,
  };
}

describe("metrics 聚合", () => {
  test("空窗口：样本为 0，比率与分位为 null", () => {
    expect(computeWindowMetrics([])).toEqual({
      finished: 0,
      succeeded: 0,
      failed: 0,
      successRate: null,
      durationSamples: 0,
      p50Ms: null,
      p95Ms: null,
    });
  });

  test("只统计成功与失败；取消、撤销与未结束的不进样本", () => {
    const m = computeWindowMetrics([
      task("a", "succeeded", 0, 1000),
      task("b", "failed", 0, 2000),
      task("c", "cancelled", 0, 3000),
      task("d", "rewound", 0, 4000),
      task("e", "running", 0, null),
      task("f", "queued", null, null),
    ]);
    expect(m.finished).toBe(2);
    expect(m.succeeded).toBe(1);
    expect(m.failed).toBe(1);
    expect(m.successRate).toBe(0.5);
    expect(m.durationSamples).toBe(2);
    expect(m.p50Ms).toBe(1000);
    expect(m.p95Ms).toBe(2000);
  });

  test("成功率是样本内的比例", () => {
    const m = computeWindowMetrics([
      task("a", "succeeded", 0, 10),
      task("b", "succeeded", 0, 10),
      task("c", "failed", 0, 10),
    ]);
    expect(m.successRate).toBeCloseTo(2 / 3, 10);
  });

  test("缺时间戳的样本计入成功率但不进耗时", () => {
    const m = computeWindowMetrics([
      task("old", "succeeded", null, null),
      task("fresh", "succeeded", 500, 1500),
    ]);
    expect(m.finished).toBe(2);
    expect(m.durationSamples).toBe(1);
    expect(m.p50Ms).toBe(1000);
  });

  test("负耗时按 0 计", () => {
    const m = computeWindowMetrics([task("skew", "failed", 2000, 1000)]);
    expect(m.p50Ms).toBe(0);
  });

  describe("percentile 用最近邻法", () => {
    const values = [10, 20, 30, 40, 60];

    test("中位数与高分位取升序第 ceil(p·n) 个", () => {
      expect(percentile(values, 50)).toBe(30);
      expect(percentile(values, 95)).toBe(60);
      expect(percentile([100, 200], 50)).toBe(100);
      expect(percentile([100, 200], 95)).toBe(200);
      expect(percentile([7], 95)).toBe(7);
    });

    test("空集合为 null", () => {
      expect(percentile([], 50)).toBeNull();
    });

    test("不修改入参顺序", () => {
      const input = [3, 1, 2];
      percentile(input, 50);
      expect(input).toEqual([3, 1, 2]);
    });
  });
});

describe("metrics 查询窗口", () => {
  let store: Store;

  afterEach(() => {
    store.close();
  });

  test("只取 24h 内结束的成功/失败任务，缺 endedAt 用 createdAt 判定", () => {
    store = new Store(":memory:");
    const now = 1_700_000_000_000;
    // insertTask 只落创建时间，状态与时间戳由状态机写入；窗口边界需要精确时间，这里直接落库
    const seed = (t: Task, createdAt = t.startedAt ?? now) => {
      store.insertTask({ ...t, createdAt });
      store.db
        .query("UPDATE tasks SET status = ?, started_at = ?, ended_at = ? WHERE id = ?")
        .run(t.status, t.startedAt, t.endedAt, t.id);
    };
    seed(task("inside", "succeeded", now - 20_000, now - 10_000));
    seed(task("outside", "failed", now - METRICS_WINDOW_MS - 20_000, now - METRICS_WINDOW_MS - 1));
    seed(task("legacy", "failed", null, null), now - 5_000);
    seed(task("cancelled", "cancelled", now - 20_000, now - 15_000));
    seed(task("running", "running", now - 30_000, null));

    const m = windowMetrics(store, now);
    expect(m.finished).toBe(2);
    expect(m.succeeded).toBe(1);
    expect(m.failed).toBe(1);
    expect(m.successRate).toBe(0.5);
    // inside 耗时 10s；legacy 没有 startedAt/endedAt 不进耗时
    expect(m.durationSamples).toBe(1);
    expect(m.p50Ms).toBe(10_000);
  });
});
