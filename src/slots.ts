import type { TaskPriority } from "./types";

/**
 * 追问槽：只对 human 任务开放，数量固定 1 个，不随 `worker.concurrency` 变化。
 * 它救的是「人在长任务进行中问一句」这一种情形；两个并发追问同时存在的价值远低于把机器压垮的风险。
 */
export const HUMAN_SLOTS = 1;

export interface SlotLimits {
  /** 工作槽上限：`worker.concurrency` */
  base: number;
  /** 追问槽上限：只对 human 任务开放 */
  extra: number;
}

/** 一类槽位的用量 */
export interface LaneUsage {
  used: number;
  limit: number;
}

export interface SlotUsage {
  base: LaneUsage;
  extra: LaneUsage;
}

export function slotLimits(concurrency: number | undefined): SlotLimits {
  return { base: Math.max(1, concurrency ?? 1), extra: HUMAN_SLOTS };
}

/** 同时在跑的任务数上限 */
export function slotCapacity(limits: SlotLimits): number {
  return limits.base + limits.extra;
}

/** 按运行中任务数拆分两类槽位：先占工作槽，超出部分才算追问槽 */
export function slotUsage(running: number, limits: SlotLimits): SlotUsage {
  const busy = Math.max(0, running);
  return {
    base: { used: Math.min(busy, limits.base), limit: limits.base },
    extra: { used: Math.max(0, busy - limits.base), limit: limits.extra },
  };
}

export function slotText(usage: SlotUsage): string {
  return `工作 ${usage.base.used}/${usage.base.limit} · 追问 +${usage.extra.used}/${usage.extra.limit}`;
}

/**
 * 排队原因：此刻这个任务还能不能开跑。
 * 有容量时返回 null（下一个调度周期就会开始）；卡住时说清在等哪一类槽位。
 */
export function queueReason(priority: TaskPriority, usage: SlotUsage): string | null {
  const busy = usage.base.used + usage.extra.used;
  const capacity = usage.base.limit + usage.extra.limit;
  if (priority === "human") return busy < capacity ? null : "追问槽位已满";
  // 新任务只用工作槽：追问槽空着也不给它
  return usage.base.used < usage.base.limit ? null : "工作槽位已满";
}
