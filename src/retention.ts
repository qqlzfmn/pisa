import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_RETENTION_DAYS, type Config } from "./config";
import type { Store } from "./store";

const DAY_MS = 86_400_000;
const TICK_MS = 3_600_000;
/** 保留自身的幂等占位行使用的 task_id；没有对应任务行，不会被按任务的清理删掉 */
const SELF_TASK = "retention";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 本地日期标识：每日清理的幂等键 */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** ISO 周标识：每周 VACUUM 的幂等键 */
export function weekKey(ms: number): string {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad2(week)}`;
}

export interface RetentionDeps {
  cfg: Config;
  store: Store;
  now?: () => number;
}

export interface RetentionResult {
  /** 删除的 events 行数 */
  events: number;
  /** 删除的 progress 文件数 */
  progress: number;
  vacuumed: boolean;
}

/**
 * 数据保留：每日清掉过期终态任务的 events 与 progress 文件，每周 VACUUM。
 * 幂等键落在 events 表（task_id = "retention"），进程重启后仍能认出本日/本周是否已执行。
 */
export class Retention {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private deps: RetentionDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.run(); // 启动即跑一次：停机期间错过的那天/那周在这里补上
    this.timer = setInterval(() => this.run(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private run(): void {
    try {
      const r = this.tick();
      if (r.events > 0 || r.progress > 0 || r.vacuumed) {
        const parts = [`events ${r.events} 行`, `progress ${r.progress} 个`];
        if (r.vacuumed) parts.push("已 VACUUM");
        console.log(`[pisa] 数据保留：清理 ${parts.join("、")}`);
      }
    } catch (e) {
      console.warn(`[pisa] 数据保留失败：${String(e).slice(0, 300)}`);
    }
  }

  /** 执行一次检查；测试直接调用 */
  tick(at = new Date(this.now())): RetentionResult {
    const { cfg, store } = this.deps;
    const result: RetentionResult = { events: 0, progress: 0, vacuumed: false };
    const stamp = at.getTime();
    const days = Math.trunc(cfg.retentionDays ?? DEFAULT_RETENTION_DAYS);

    // 非正数视为关闭清理；VACUUM 仍按周执行
    if (days > 0 && store.claimEvent(`retention:cleanup:${dayKey(stamp)}`, SELF_TASK, stamp)) {
      const cutoff = stamp - days * DAY_MS;
      for (const id of store.finishedTaskIdsBefore(cutoff)) {
        const file = join(resolve(cfg.stateDir), "progress", `${id}.jsonl`);
        if (existsSync(file)) {
          rmSync(file, { force: true });
          result.progress += 1;
        }
      }
      result.events = store.purgeEvents(cutoff);
    }

    if (store.claimEvent(`retention:vacuum:${weekKey(stamp)}`, SELF_TASK, stamp)) {
      store.vacuum();
      result.vacuumed = true;
    }
    return result;
  }
}
