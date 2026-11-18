import type { Store } from "./store";

/** 一天的任务流量；successRate/avgDurationMs 没有样本时为 null */
export interface DayMetrics {
  date: string;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  successRate: number | null;
  avgDurationMs: number | null;
  /** 当天结束时刻的排队深度 */
  queueDepth: number;
}

export const METRICS_MAX_DAYS = 90;
export const METRICS_DEFAULT_DAYS = 14;

/**
 * 按本地自然日分桶的指标序列，旧 → 新。每桶一次分组查询，天数上限 90。
 * 成功率只算有明确结果的样本（succeeded / failed），取消不计入分母。
 */
export function metricsSeries(store: Store, days = METRICS_DEFAULT_DAYS, now = Date.now()): DayMetrics[] {
  const count = Math.min(METRICS_MAX_DAYS, Math.max(1, Math.trunc(Number(days)) || METRICS_DEFAULT_DAYS));
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const starts: Date[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    starts.push(d);
  }

  return starts.map((start, i) => {
    const from = start.getTime();
    const to = i + 1 < starts.length ? starts[i + 1]!.getTime() : now + 1;
    const rows = store.dayStats(from, to);
    const by = new Map(rows.map((r) => [r.status, r]));
    const succeeded = by.get("succeeded")?.n ?? 0;
    const failed = by.get("failed")?.n ?? 0;
    const cancelled = by.get("cancelled")?.n ?? 0;
    const total = rows.reduce((sum, r) => sum + r.n, 0);
    const decided = succeeded + failed;
    const avg = by.get("succeeded")?.avgDuration;
    return {
      // 本地日期，页面按 MM-DD 展示；padStart 保证字典序等于时间序
      date: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`,
      total,
      succeeded,
      failed,
      cancelled,
      successRate: decided > 0 ? succeeded / decided : null,
      avgDurationMs: typeof avg === "number" ? Math.round(avg) : null,
      queueDepth: store.queueDepthAt(Math.min(to - 1, now)),
    };
  });
}
