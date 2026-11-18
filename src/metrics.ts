import type { Store } from "./store";
import type { QueueSample, Task } from "./types";

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

/** 趋势图的一个时间桶；窗口内没有任何样本的字段为 null，图表据此留空 */
export interface MetricBucket {
  /** 桶起点（毫秒时间戳） */
  from: number;
  finished: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /** 排队数的均值与峰值 */
  queueAvg: number | null;
  queueMax: number | null;
  runningAvg: number | null;
}

/**
 * 把 [from, to] 等分成 buckets 个桶：任务按结束时间、采样按采样时间归桶。
 * 末桶包含右端点，其余左闭右开，与 finishedBetween 的闭区间口径衔接。
 */
export function bucketMetrics(
  tasks: readonly Task[],
  samples: readonly QueueSample[],
  from: number,
  to: number,
  buckets: number,
): MetricBucket[] {
  const width = (to - from) / buckets;
  const inBucket = (at: number, start: number, end: number, last: boolean): boolean =>
    at >= start && (last ? at <= end : at < end);
  const avg = (values: readonly number[]): number | null =>
    values.length > 0 ? Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10 : null;
  const result: MetricBucket[] = [];
  for (let i = 0; i < buckets; i++) {
    const start = from + width * i;
    const end = i === buckets - 1 ? to : start + width;
    const last = i === buckets - 1;
    const window = computeWindowMetrics(tasks.filter((t) => inBucket(t.endedAt ?? t.createdAt, start, end, last)));
    const points = samples.filter((s) => inBucket(s.at, start, end, last));
    const queued = points.map((p) => p.queued);
    const running = points.map((p) => p.running);
    result.push({
      from: start,
      finished: window.finished,
      succeeded: window.succeeded,
      failed: window.failed,
      successRate: window.successRate,
      p50Ms: window.p50Ms,
      p95Ms: window.p95Ms,
      queueAvg: avg(queued),
      queueMax: queued.length > 0 ? Math.max(...queued) : null,
      runningAvg: avg(running),
    });
  }
  return result;
}
