import type { TaskStatus } from "./types";

/**
 * 任务阶段：由 status 与交付字段派生，回答「现在在等谁、需要什么」。
 * 不写库、不改变 status；同一次状态快照里阶段是确定的。
 */
export type TaskStage = "person/answer" | "person/review" | "working/queued" | "working" | "idle";

/** 判定阶段所需的最小输入：Task 满足该结构 */
export interface StageInput {
  status: TaskStatus;
  branch: string | null;
  prUrl: string | null;
}

export interface StageRule {
  stage: TaskStage;
  matches: (t: StageInput) => boolean;
}

/**
 * 阶段规则表，按顺序第一条命中生效。
 * 各行条件互斥且覆盖全部 TaskStatus；新增状态时这里必须同步，否则 taskStage 会报错。
 */
export const STAGE_RULES: readonly StageRule[] = [
  {
    stage: "person/answer",
    // paused 等人决定 resume/cancel；failed 没有自动重试，同样需要人处理
    matches: ({ status }) => status === "paused" || status === "failed",
  },
  {
    stage: "person/review",
    // 成功任务已有分支或 PR，等人评审或 merge
    matches: ({ status, branch, prUrl }) => status === "succeeded" && (branch !== null || prUrl !== null),
  },
  { stage: "working/queued", matches: ({ status }) => status === "queued" },
  { stage: "working", matches: ({ status }) => status === "running" },
  {
    stage: "idle",
    // 成功但没有可评审对象（如只改本地且未落分支）、以及取消/撤销后的收尾态
    matches: ({ status, branch, prUrl }) =>
      status === "cancelled" || status === "rewound" || (status === "succeeded" && branch === null && prUrl === null),
  },
];

/** 阶段的中文说明，看板与详情共用 */
export const STAGE_LABEL: Record<TaskStage, string> = {
  "person/answer": "等你处理",
  "person/review": "等你评审",
  "working/queued": "等空闲槽位",
  working: "执行中",
  idle: "无待办",
};

export function taskStage(t: StageInput): TaskStage {
  const rule = STAGE_RULES.find((r) => r.matches(t));
  if (!rule) throw new Error(`任务状态 ${t.status} 没有对应阶段`);
  return rule.stage;
}

/** 看板与详情的一行展示：阶段名 + 中文说明 */
export function stageText(t: StageInput): string {
  const stage = taskStage(t);
  return `${stage}（${STAGE_LABEL[stage]}）`;
}
