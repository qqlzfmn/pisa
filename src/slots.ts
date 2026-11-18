import type { Task } from "./types";

/**
 * 调度通道：worker 跑新任务；human 跑人对已有任务的追问，占独立槽位。
 * 人的追问不能排在成批新任务后面——槽位满了也要能进。
 */
export const LANES = ["human", "worker"] as const;
export type Lane = (typeof LANES)[number];

/** 追问槽位数：固定 1 个，不随 worker 并发数变化，也不被新任务占用 */
export const HUMAN_SLOTS = 1;

export const LANE_LABEL: Record<Lane, string> = { human: "追问", worker: "worker" };

/** 每个通道的槽位上限：worker 跟随配置，human 固定 HUMAN_SLOTS */
export function slotLimits(concurrency: number | undefined): Record<Lane, number> {
  return { human: HUMAN_SLOTS, worker: Math.max(1, concurrency ?? 1) };
}

export interface SlotUsage {
  limits: Record<Lane, number>;
  running: Record<Lane, number>;
  queued: Record<Lane, number>;
}

/** 按通道统计占用；输入是同一时刻的任务快照 */
export function slotUsage(
  tasks: readonly Pick<Task, "lane" | "status">[],
  concurrency: number | undefined,
): SlotUsage {
  const usage: SlotUsage = {
    limits: slotLimits(concurrency),
    running: { human: 0, worker: 0 },
    queued: { human: 0, worker: 0 },
  };
  for (const t of tasks) {
    if (t.status === "running") usage.running[t.lane] += 1;
    else if (t.status === "queued") usage.queued[t.lane] += 1;
  }
  return usage;
}

/** 排队原因：槽位已满就说在等哪条通道，未满则是下个调度周期补位 */
export function queueReason(lane: Lane, usage: SlotUsage): string {
  if (usage.running[lane] < usage.limits[lane]) return "即将开始";
  return lane === "human" ? "等追问槽位" : "等 worker 槽位";
}

/** 看板的槽位行 */
export function formatSlots(usage: SlotUsage): string {
  const queued = usage.queued.human + usage.queued.worker;
  const line = `槽位：${LANE_LABEL.worker} ${usage.running.worker}/${usage.limits.worker} · ${LANE_LABEL.human} ${usage.running.human}/${usage.limits.human}`;
  return queued === 0 ? line : `${line} · 排队 ${queued}`;
}
