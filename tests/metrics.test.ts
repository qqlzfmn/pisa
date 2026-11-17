import { describe, expect, test } from "bun:test";
import { summarize } from "../src/metrics";
import type { Task, TaskStatus } from "../src/types";

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

function task(over: Partial<Task> & { id: string }): Task {
  return {
    source: `seed:${over.id}`,
    channel: "fake",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "任务",
    status: "succeeded" as TaskStatus,
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
    createdAt: NOW - HOUR,
    startedAt: NOW - HOUR,
    endedAt: NOW - 10_000,
    cancelRequested: false,
    ...over,
  };
}

function finished(id: string, status: TaskStatus, startedAt: number, endedAt: number, repo = "demo"): Task {
  return task({ id, status, repo, startedAt, endedAt });
}

describe("summarize", () => {
  test("空样本：全零且分位为 null", () => {
    expect(summarize([], NOW - 24 * HOUR)).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      successRate: null,
      p50Ms: null,
      p95Ms: null,
      byRepo: {},
    });
  });

  test("成功率与最近秩分位", () => {
    const metrics = summarize(
      [
        finished("a", "succeeded", NOW - 30_000, NOW - 20_000), // 10s
        finished("b", "succeeded", NOW - 40_000, NOW - 20_000), // 20s
        finished("c", "failed", NOW - 80_000, NOW - 20_000), // 60s
      ],
      NOW - 24 * HOUR,
    );
    expect(metrics.total).toBe(3);
    expect(metrics.succeeded).toBe(2);
    expect(metrics.failed).toBe(1);
    expect(metrics.successRate).toBe(0.667);
    expect(metrics.p50Ms).toBe(20_000);
    expect(metrics.p95Ms).toBe(60_000);
  });

  test("窗口外的任务不计入", () => {
    const metrics = summarize(
      [finished("old", "succeeded", NOW - 26 * HOUR, NOW - 25 * HOUR), finished("new", "succeeded", NOW - 2000, NOW - 1000)],
      NOW - 24 * HOUR,
    );
    expect(metrics.total).toBe(1);
    expect(metrics.byRepo).toEqual({ demo: 1 });
  });

  test("取消与撤销计入总数但不进成功率分母；未开始的任务不进耗时样本", () => {
    const metrics = summarize(
      [
        finished("ok", "succeeded", NOW - 20_000, NOW - 10_000),
        task({ id: "cancel", status: "cancelled", startedAt: null, endedAt: NOW - 4000 }),
        task({ id: "rewound", status: "rewound", startedAt: null, endedAt: NOW - 3000 }),
      ],
      NOW - 24 * HOUR,
    );
    expect(metrics.total).toBe(3);
    expect(metrics.cancelled).toBe(2);
    expect(metrics.successRate).toBe(1);
    expect(metrics.p50Ms).toBe(10_000);
    expect(metrics.p95Ms).toBe(10_000);
  });

  test("没有带开始时间的终态任务时分位为 null", () => {
    const metrics = summarize([task({ id: "q", status: "cancelled", startedAt: null, endedAt: NOW - 1000 })], NOW - 24 * HOUR);
    expect(metrics.total).toBe(1);
    expect(metrics.p50Ms).toBeNull();
    expect(metrics.p95Ms).toBeNull();
  });

  test("按仓库统计完成数", () => {
    const metrics = summarize(
      [
        finished("a", "succeeded", NOW - 3000, NOW - 2000, "alpha"),
        finished("b", "failed", NOW - 3000, NOW - 2000, "beta"),
        finished("c", "succeeded", NOW - 3000, NOW - 2000, "alpha"),
      ],
      NOW - 24 * HOUR,
    );
    expect(metrics.byRepo).toEqual({ alpha: 2, beta: 1 });
  });

  test("成功率保留 3 位小数", () => {
    const metrics = summarize(
      [finished("a", "succeeded", NOW - 2000, NOW - 1000), finished("b", "failed", NOW - 2000, NOW - 1000), finished("c", "failed", NOW - 2000, NOW - 1000)],
      NOW - 24 * HOUR,
    );
    expect(metrics.successRate).toBe(0.333);
  });
});
