import { DEFAULT_HUMAN_SLOTS, type Config } from "./config";
import type { Lane, Task } from "./types";

/** 槽位上限：base 给所有任务，human 是人等的追问可多占的备用槽位 */
export interface SlotLimits {
  base: number;
  human: number;
}

/** 槽位快照：base.used 只数 base 车道的任务，human.used 只数 human 车道的任务 */
export interface SlotUsage {
  limits: SlotLimits;
  base: { used: number; limit: number };
  human: { used: number; limit: number };
  used: number;
  capacity: number;
}

export function slotLimits(cfg: Config): SlotLimits {
  return {
    base: Math.max(1, Math.floor(cfg.worker.concurrency ?? 1)),
    human: Math.max(0, Math.floor(cfg.worker.humanSlots ?? DEFAULT_HUMAN_SLOTS)),
  };
}

/**
 * 该车道此刻还能不能开新任务：
 * base 车道只看基础槽位（不碰备用）；human 车道看总占用是否已达 base + human。
 */
export function canLaneClaim(lane: Lane, usage: SlotUsage): boolean {
  if (lane === "human") return usage.used < usage.capacity;
  return usage.base.used < usage.base.limit;
}

function makeUsage(limits: SlotLimits, baseUsed: number, humanUsed: number): SlotUsage {
  return {
    limits,
    base: { used: baseUsed, limit: limits.base },
    human: { used: humanUsed, limit: limits.human },
    used: baseUsed + humanUsed,
    capacity: limits.base + limits.human,
  };
}

/** 从库里在跑的任务还原槽位占用：只读入口（CLI、Web）没有进程内计数可用 */
export function usageFromTasks(tasks: readonly Pick<Task, "lane">[], limits: SlotLimits): SlotUsage {
  let baseUsed = 0;
  let humanUsed = 0;
  for (const task of tasks) {
    if (task.lane === "human") humanUsed += 1;
    else baseUsed += 1;
  }
  return makeUsage(limits, baseUsed, humanUsed);
}

/**
 * 显式槽位计数：唯一决定「还能不能再开一个」的地方。
 * 单独跑着的 human 任务不占基础槽位，基础槽位空出后新任务照样能补位。
 */
export class Slots {
  private readonly held = new Map<string, Lane>();

  constructor(private readonly limits: SlotLimits) {}

  canClaim(lane: Lane): boolean {
    return canLaneClaim(lane, this.usage());
  }

  /** 调用方必须先 canClaim；违反说明调度逻辑有 bug，直接抛错而不是默默超卖 */
  claim(id: string, lane: Lane): void {
    const usage = this.usage();
    if (!canLaneClaim(lane, usage)) {
      const capacity = lane === "human" ? usage.capacity : usage.base.limit;
      const used = lane === "human" ? usage.used : usage.base.used;
      throw new Error(`槽位已满：${lane} 车道 ${used}/${capacity}`);
    }
    this.held.set(id, lane);
  }

  release(id: string): void {
    this.held.delete(id);
  }

  usage(): SlotUsage {
    let baseUsed = 0;
    let humanUsed = 0;
    for (const lane of this.held.values()) {
      if (lane === "human") humanUsed += 1;
      else baseUsed += 1;
    }
    return makeUsage(this.limits, baseUsed, humanUsed);
  }
}

/** 排队原因：base 看基础占用，human 看含备用槽位的总占用 */
export function queueReason(lane: Lane, usage: SlotUsage): string {
  if (lane === "human") return `等槽位（${usage.used}/${usage.capacity} 已满，含备用）`;
  return `等槽位（基础 ${usage.base.used}/${usage.base.limit} 已满）`;
}
