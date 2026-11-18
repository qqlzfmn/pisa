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

/** 单个时间桶：`start` 为桶起点，`finished` 起的字段与 WindowMetrics 同口径 */
export interface MetricBucket extends WindowMetrics {
  start: number;
  /** 桶起点时刻排队中的任务数 */
  queueDepth: number;
  /** 桶起点时刻执行中的任务数 */
  running: number;
}

export interface MetricHistory {
  from: number;
  to: number;
  summary: WindowMetrics;
  buckets: MetricBucket[];
}

/** 桶起点已排队：创建于之前且尚未开始；未开始且已有结束时间说明排队期间被取消 */
function queuedAt(task: Task, at: number): boolean {
  if (task.createdAt > at) return false;
  if (task.startedAt !== null) return task.startedAt > at;
  if (task.endedAt !== null) return task.endedAt > at;
  return task.status === "queued";
}

function runningAt(task: Task, at: number): boolean {
  if (task.startedAt === null || task.startedAt > at) return false;
  if (task.endedAt !== null) return task.endedAt > at;
  return task.status === "running";
}

/**
 * 按小时切历史：完成数/成功率/耗时分位按 endedAt 归桶，队列深度与运行数在桶起点采样。
 * 桶边界对齐 epoch 整数倍，图上每个柱子的时间点是确定的，不随刷新漂移。
 */
export function metricHistory(
  tasks: readonly Task[],
  now: number,
  hours: number,
  bucketMs = 60 * 60 * 1000,
): MetricHistory {
  const span = Math.max(1, Math.floor(hours));
  const lastStart = Math.floor(now / bucketMs) * bucketMs;
  const firstStart = lastStart - (span - 1) * bucketMs;
  const groups: Task[][] = Array.from({ length: span }, () => []);
  for (const t of tasks) {
    if (t.endedAt === null) continue;
    if (t.status !== "succeeded" && t.status !== "failed") continue;
    const index = Math.floor((t.endedAt - firstStart) / bucketMs);
    if (index >= 0 && index < span) groups[index]!.push(t);
  }
  const buckets = groups.map((group, index) => {
    const start = firstStart + index * bucketMs;
    return {
      ...computeWindowMetrics(group),
      start,
      queueDepth: tasks.filter((t) => queuedAt(t, start)).length,
      running: tasks.filter((t) => runningAt(t, start)).length,
    };
  });
  const inWindow = tasks.filter(
    (t) => t.endedAt !== null && t.endedAt >= firstStart && t.endedAt <= now,
  );
  return { from: firstStart, to: now, summary: computeWindowMetrics(inWindow), buckets };
}
