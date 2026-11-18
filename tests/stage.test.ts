import { describe, expect, test } from "bun:test";
import { ALLOWED, type TaskStatus } from "../src/types";
import { STAGE_LABEL, STAGE_RULES, taskStage, type StageInput, type TaskStage } from "../src/stage";

function input(status: TaskStatus, extra: Partial<StageInput> = {}): StageInput {
  return { status, branch: null, prUrl: null, ...extra };
}

describe("任务阶段判定", () => {
  const cases: Array<[string, StageInput, TaskStage]> = [
    ["排队等空闲槽位", input("queued"), "working/queued"],
    ["正在执行", input("running"), "working"],
    ["暂停等人恢复或取消", input("paused"), "person/answer"],
    ["成功且已建分支，等人评审", input("succeeded", { branch: "pisa/t_1" }), "person/review"],
    ["成功且只有 PR，等人评审", input("succeeded", { prUrl: "https://github.com/o/r/pull/1" }), "person/review"],
    ["成功但没有交付对象", input("succeeded"), "idle"],
    ["失败等人处理", input("failed"), "person/answer"],
    ["取消后无待办", input("cancelled"), "idle"],
    ["撤销后无待办", input("rewound"), "idle"],
  ];

  for (const [name, task, expected] of cases) {
    test(name, () => expect(taskStage(task)).toBe(expected));
  }
});

describe("任务阶段规则表", () => {
  test("覆盖全部状态且每个输入只命中一条", () => {
    for (const status of Object.keys(ALLOWED) as TaskStatus[]) {
      for (const branch of [null, "pisa/t_1"]) {
        for (const prUrl of [null, "https://github.com/o/r/pull/1"]) {
          const task = input(status, { branch, prUrl });
          const matched = STAGE_RULES.filter((rule) => rule.matches(task));
          expect(matched.length, `${status} branch=${branch} prUrl=${prUrl}`).toBe(1);
        }
      }
    }
  });

  test("每个阶段都有中文说明", () => {
    const used = new Set(STAGE_RULES.map((rule) => rule.stage));
    expect([...used].sort()).toEqual((Object.keys(STAGE_LABEL) as TaskStage[]).sort());
  });
});
