import type { Task } from "./types";

/** 指标窗口：最近 24 小时 */
export const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;

const TERMINAL: Record<string, true> = { succeeded: true, failed: true, cancelled: true, rewound: true };

export interface WindowMetrics {
  /** 窗口内全部终态任务 */
  total: number;
  succeeded: number;
  failed: number;
  /** 取消与撤销 */
  cancelled: number;
  /** succeeded / (succeeded + failed)，保留 3 位小数；分母为 0 时为 null */
  successRate: number | null;
  /** 最近秩分位，单位毫秒；无带开始/结束时间的样本时为 null */
  p50Ms: number | null;
  p95Ms: number | null;
  /** 窗口内每个仓库的完成数 */
  byRepo: Record<string, number>;
}

/**
 * 聚合窗口内（endedAt 在 since 之后）的终态任务。
 * 成功率只把成功与失败当分母：取消/撤销不是质量信号。
 * 耗时只取 startedAt 与 endedAt 都存在的任务。
 */
export function summarize(tasks: Task[], since: number): WindowMetrics {
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  const durations: number[] = [];
  const byRepo: Record<string, number> = {};

  for (const t of tasks) {
    if (!TERMINAL[t.status] || t.endedAt === null || t.endedAt < since) continue;
    total += 1;
    byRepo[t.repo] = (byRepo[t.repo] ?? 0) + 1;
    if (t.status === "succeeded") succeeded += 1;
    else if (t.status === "failed") failed += 1;
    else cancelled += 1;
    if (t.startedAt !== null) durations.push(t.endedAt - t.startedAt);
  }

  durations.sort((a, b) => a - b);
  const decided = succeeded + failed;
  return {
    total,
    succeeded,
    failed,
    cancelled,
    successRate: decided === 0 ? null : Math.round((succeeded / decided) * 1000) / 1000,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    byRepo,
  };
}

/** 最近秩：排序后取 ceil(p*n)-1，不小于样本最小值 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}
