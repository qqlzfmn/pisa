import type { Task, TaskStatus } from "./types";

/**
 * 任务阶段：status 说明进程在干什么，阶段回答「现在在等谁」。
 * 由 {@link deriveStage} 从 status 与 prUrl 派生，只读投影，不落库、不改写 status。
 */
export type TaskStage = "person/answer" | "person/review" | "working/queued" | "idle";

interface StageRule {
  stage: TaskStage;
  /** 命中的状态集合 */
  statuses: readonly TaskStatus[];
  /** 额外条件：prUrl 的有无与该值一致才命中；省略表示不看 PR */
  hasPr?: boolean;
}

/**
 * 阶段规则表：唯一事实源。
 * 条件两两互斥且覆盖全部状态 × PR 有无的组合（stage.test.ts 全组合断言），判定与顺序无关；
 * 数组按「等人应答 → 等人评审 → 等工位 → 空闲」排列，只为阅读。
 */
export const STAGE_RULES: readonly StageRule[] = [
  { stage: "person/answer", statuses: ["paused"] },
  { stage: "person/review", statuses: ["succeeded"], hasPr: true },
  { stage: "idle", statuses: ["succeeded"], hasPr: false },
  { stage: "working/queued", statuses: ["queued", "running"] },
  { stage: "idle", statuses: ["failed", "cancelled", "rewound"] },
];

/** 派生阶段：第一条命中的规则即结论；没有命中说明规则表有缺口，直接报错而不是猜 */
export function deriveStage(task: Pick<Task, "status" | "prUrl">): TaskStage {
  const hasPr = task.prUrl !== null;
  const rule = STAGE_RULES.find(
    (r) => r.statuses.includes(task.status) && (r.hasPr === undefined || r.hasPr === hasPr),
  );
  if (!rule) throw new Error(`阶段规则表未覆盖：${task.status} hasPr=${hasPr}`);
  return rule.stage;
}
