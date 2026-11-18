import type { Store } from "./store";
import type { Task } from "./types";

/** 健康指标的统计窗口：最近 24 小时 */
export const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 24h 指标：成功率与耗时分位都只看执行结果，取消/撤销是用户行为不算样本 */
export interface WindowMetrics {
  /** 样本数 = succeeded + failed */
  finished: number;
  succeeded: number;
  failed: number;
  /** 成功 / 样本数；没有样本时为 null */
  successRate: number | null;
  /** 参与耗时统计的任务数：要求 startedAt 与 endedAt 都在 */
  durationSamples: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** 最近邻分位（nearest-rank）：升序取第 ceil(p% · n) 个 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

/**
 * 聚合 24h 指标：入参是窗口内已结束的任务。
 * 耗时缺任一时间戳就不进样本，因此 durationSamples 可能小于 finished。
 */
export function computeWindowMetrics(tasks: readonly Task[]): WindowMetrics {
  let succeeded = 0;
  let failed = 0;
  const durations: number[] = [];
  for (const t of tasks) {
    if (t.status !== "succeeded" && t.status !== "failed") continue;
    if (t.status === "succeeded") succeeded++;
    else failed++;
    if (t.startedAt !== null && t.endedAt !== null) durations.push(Math.max(0, t.endedAt - t.startedAt));
  }
  const finished = succeeded + failed;
  return {
    finished,
    succeeded,
    failed,
    successRate: finished === 0 ? null : succeeded / finished,
    durationSamples: durations.length,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
  };
}

/** 看板、CLI 与 /health 共用同一口径：查库 + 聚合 */
export function windowMetrics(store: Store, now = Date.now()): WindowMetrics {
  return computeWindowMetrics(store.finishedBetween(now - METRICS_WINDOW_MS, now));
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 图表的一个时间桶：窗口指标 + 桶起点与本地日期标签 */
export interface StatsBucket extends WindowMetrics {
  start: number;
  label: string;
}

export interface QueuePoint {
  at: number;
  depth: number;
}

/** 控制台趋势图的数据：按桶聚合的完成/成功/耗时，加上按步长采样的队列深度 */
export interface StatsSeries {
  from: number;
  to: number;
  bucketMs: number;
  queueStepMs: number;
  buckets: StatsBucket[];
  queue: QueuePoint[];
}

function dayLabel(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 某时刻还没开始也没结束的任务 = 排队中；paused/running 已开始，不算队列 */
function queueDepthAt(tasks: readonly Task[], at: number): number {
  let depth = 0;
  for (const task of tasks) {
    if (task.createdAt > at) break;
    if ((task.startedAt === null || task.startedAt > at) && (task.endedAt === null || task.endedAt > at)) depth++;
  }
  return depth;
}

/**
 * 生成趋势序列。任务需覆盖整个窗口（见 Store.tasksInWindow）：
 * 窗口前创建、窗口内仍在排队的任务不能漏，否则队列深度从 0 开始。
 */
export function buildStatsSeries(
  tasks: readonly Task[],
  from: number,
  to: number,
  bucketMs: number,
  queueStepMs: number,
): StatsSeries {
  const span = Math.max(0, to - from);
  const width = Math.max(1, bucketMs);
  const step = Math.max(1, queueStepMs);
  const sorted = [...tasks].sort((a, b) => a.createdAt - b.createdAt);
  const count = Math.max(1, Math.ceil(span / width));

  const buckets: StatsBucket[] = [];
  for (let index = 0; index < count; index++) {
    const start = from + index * width;
    const end = index === count - 1 ? to + 1 : start + width;
    const closed = sorted.filter((t) => t.endedAt !== null && t.endedAt >= start && t.endedAt < end);
    buckets.push({ start, label: dayLabel(start), ...computeWindowMetrics(closed) });
  }

  const queue: QueuePoint[] = [];
  for (let at = from; at <= to; at += step) queue.push({ at, depth: queueDepthAt(sorted, at) });
  if (queue.length === 0 || queue[queue.length - 1]!.at !== to) queue.push({ at: to, depth: queueDepthAt(sorted, to) });

  return { from, to, bucketMs: width, queueStepMs: step, buckets, queue };
}
