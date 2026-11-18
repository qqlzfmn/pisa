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
