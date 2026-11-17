import { describe, expect, test } from "bun:test";
import { dailyMetrics, queueDepth } from "../src/web/metrics";
import type { Task, TaskStatus } from "../src/types";

const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime(); // 本地时间 2026-11-18 12:00
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function task(id: string, over: Partial<Task> & { status: TaskStatus }): Task {
  return {
    id,
    source: `seed:${id}`,
    channel: "cli",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "做点事",
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
    createdAt: NOW - DAY,
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
    ...over,
  };
}

describe("dailyMetrics", () => {
  test("成功率只算终态，平均耗时只算成功", () => {
    const points = dailyMetrics(
      [
        task("a", { status: "succeeded", createdAt: NOW - HOUR, startedAt: NOW - HOUR, endedAt: NOW - 1_800_000 }),
        task("b", { status: "succeeded", createdAt: NOW - HOUR, startedAt: NOW - HOUR, endedAt: NOW - 600_000 }),
        task("c", { status: "failed", createdAt: NOW - HOUR, startedAt: NOW - HOUR, endedAt: NOW - 600_000 }),
        task("d", { status: "cancelled", createdAt: NOW - HOUR, endedAt: NOW - 600_000 }),
      ],
      NOW,
    );
    const today = points[points.length - 1]!;
    expect(points).toHaveLength(7);
    expect(today.date).toBe("2026-11-18");
    expect(today.succeeded).toBe(2);
    expect(today.failed).toBe(1);
    expect(today.cancelled).toBe(1);
    expect(today.successRate).toBe(0.5);
    // a: 30 分钟，b: 50 分钟 → 平均 40 分钟
    expect(today.avgDurationMs).toBe(2_400_000);
  });

  test("没有终态的一天成功率与耗时都是 null", () => {
    const points = dailyMetrics([task("a", { status: "running", startedAt: NOW - HOUR })], NOW);
    const today = points[points.length - 1]!;
    expect(today.successRate).toBeNull();
    expect(today.avgDurationMs).toBeNull();
  });

  test("按完成日分桶，昨天完成的进昨天", () => {
    const yesterdayNoon = NOW - DAY;
    const points = dailyMetrics(
      [task("a", { status: "failed", createdAt: yesterdayNoon - HOUR, endedAt: yesterdayNoon })],
      NOW,
    );
    const yesterday = points[points.length - 2]!;
    expect(yesterday.date).toBe("2026-11-17");
    expect(yesterday.failed).toBe(1);
    expect(yesterday.successRate).toBe(0);
    expect(points[points.length - 1]!.successRate).toBeNull();
  });

  test("超出窗口的任务不计入", () => {
    const points = dailyMetrics([task("old", { status: "succeeded", createdAt: NOW - 30 * DAY, endedAt: NOW - 30 * DAY })], NOW);
    expect(points.every((p) => p.succeeded === 0)).toBe(true);
  });
});

describe("queueDepth", () => {
  test("排队与运行区间按时间戳推断", () => {
    const startedBeforeHour = Math.floor(NOW / HOUR) * HOUR - 2 * HOUR;
    const points = queueDepth(
      [
        // 排队 3 小时后在 1 小时前开始运行，仍在跑
        task("run", { status: "running", createdAt: startedBeforeHour - 3 * HOUR, startedAt: startedBeforeHour }),
        // 一直在排队，没有开始
        task("wait", { status: "queued", createdAt: startedBeforeHour - 3 * HOUR }),
      ],
      NOW,
    );
    expect(points).toHaveLength(24);
    const last = points[points.length - 1]!;
    expect(last.running).toBe(1);
    expect(last.queued).toBe(1);
    const threeHoursAgo = points[points.length - 4]!;
    expect(threeHoursAgo.running).toBe(0);
    expect(threeHoursAgo.queued).toBe(2);
  });

  test("paused 没有结束时间，按运行中计入", () => {
    const points = queueDepth([task("p", { status: "paused", createdAt: NOW - 5 * HOUR, startedAt: NOW - 4 * HOUR })], NOW);
    expect(points[points.length - 1]!.running).toBe(1);
    expect(points[points.length - 1]!.queued).toBe(0);
  });

  test("已结束任务不再计入", () => {
    const points = queueDepth(
      [task("done", { status: "succeeded", createdAt: NOW - 5 * HOUR, startedAt: NOW - 4 * HOUR, endedAt: NOW - 3 * HOUR })],
      NOW,
    );
    const last = points[points.length - 1]!;
    expect(last.running).toBe(0);
    expect(last.queued).toBe(0);
  });

  test("标签按整点、最后一格是当前小时", () => {
    const points = queueDepth([], new Date(2026, 10, 18, 12, 34, 0).getTime(), 3);
    expect(points.map((p) => p.label)).toEqual(["10:00", "11:00", "12:00"]);
    expect(points.every((p) => p.queued === 0 && p.running === 0)).toBe(true);
  });
});
