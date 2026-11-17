import type { Task } from "../types";

export interface DayPoint {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** 无终态任务时为 null */
  successRate: number | null;
  /** 只统计 succeeded，从 startedAt ?? createdAt 到 endedAt */
  avgDurationMs: number | null;
}

export interface QueuePoint {
  /** 小时标签 HH:00 */
  label: string;
  queued: number;
  running: number;
}

const DAY_MS = 86_400_000;

const pad = (n: number): string => String(n).padStart(2, "0");

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 最近 days 天的成功率与平均耗时，按完成时间分桶；今天在最后一位 */
export function dailyMetrics(tasks: Task[], now: number, days = 7): DayPoint[] {
  const buckets = new Map<string, DayPoint>();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(today.getTime() - i * DAY_MS);
    buckets.set(key, { date: key, succeeded: 0, failed: 0, cancelled: 0, successRate: null, avgDurationMs: null });
  }

  const durations = new Map<string, number[]>();
  for (const t of tasks) {
    if (t.endedAt === null) continue;
    const bucket = buckets.get(dayKey(t.endedAt));
    if (!bucket) continue;
    if (t.status === "succeeded") {
      bucket.succeeded += 1;
      const start = t.startedAt ?? t.createdAt;
      const list = durations.get(bucket.date) ?? [];
      list.push(Math.max(0, t.endedAt - start));
      durations.set(bucket.date, list);
    } else if (t.status === "failed") {
      bucket.failed += 1;
    } else if (t.status === "cancelled") {
      bucket.cancelled += 1;
    }
  }

  for (const bucket of buckets.values()) {
    const finished = bucket.succeeded + bucket.failed + bucket.cancelled;
    bucket.successRate = finished > 0 ? bucket.succeeded / finished : null;
    const list = durations.get(bucket.date);
    bucket.avgDurationMs =
      list && list.length > 0 ? Math.round(list.reduce((sum, v) => sum + v, 0) / list.length) : null;
  }

  return [...buckets.values()];
}

function queuedAt(t: Task, at: number): boolean {
  const end = t.startedAt ?? t.endedAt ?? Number.POSITIVE_INFINITY;
  return at >= t.createdAt && at < end;
}

function runningAt(t: Task, at: number): boolean {
  if (t.startedAt === null) return false;
  const end = t.endedAt ?? Number.POSITIVE_INFINITY;
  return at >= t.startedAt && at < end;
}

/**
 * 最近 hours 小时每个整点的排队/运行数量，采样点在整点之后 1 秒。
 * 区间由时间戳推出：paused 任务没有 endedAt，按运行中计入。
 */
export function queueDepth(tasks: Task[], now: number, hours = 24): QueuePoint[] {
  const points: QueuePoint[] = [];
  const currentHour = Math.floor(now / 3_600_000) * 3_600_000;
  for (let i = hours - 1; i >= 0; i--) {
    const at = currentHour - i * 3_600_000 + 1000;
    const d = new Date(at);
    points.push({
      label: `${pad(d.getHours())}:00`,
      queued: tasks.filter((t) => queuedAt(t, at)).length,
      running: tasks.filter((t) => runningAt(t, at)).length,
    });
  }
  return points;
}
