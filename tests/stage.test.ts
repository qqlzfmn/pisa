import { describe, expect, test } from "bun:test";
import { deriveStage, STAGE_RULES } from "../src/stage";
import { ALLOWED, type TaskStatus } from "../src/types";

const STATUSES = Object.keys(ALLOWED) as TaskStatus[];

function stage(status: TaskStatus, prUrl: string | null = null): string {
  return deriveStage({ status, prUrl });
}

describe("stage 规则表", () => {
  test("覆盖全部状态 × PR 有无，每个组合恰好命中一条", () => {
    for (const status of STATUSES) {
      for (const hasPr of [true, false]) {
        const matched = STAGE_RULES.filter(
          (r) => r.statuses.includes(status) && (r.hasPr === undefined || r.hasPr === hasPr),
        );
        expect({ status, hasPr, matched: matched.length }).toEqual({ status, hasPr, matched: 1 });
      }
    }
  });
});

describe("deriveStage", () => {
  test("中断任务等人应答", () => {
    expect(stage("paused")).toBe("person/answer");
  });

  test("成功且交付 PR 等人评审", () => {
    expect(stage("succeeded", "https://github.com/o/r/pull/1")).toBe("person/review");
  });

  test("成功但没有 PR 空闲", () => {
    expect(stage("succeeded")).toBe("idle");
  });

  test("排队与执行中都在等工作进程", () => {
    expect(stage("queued")).toBe("working/queued");
    expect(stage("running")).toBe("working/queued");
    expect(stage("running", "https://github.com/o/r/pull/2")).toBe("working/queued");
  });

  test("失败、取消、已撤销空闲", () => {
    expect(stage("failed")).toBe("idle");
    expect(stage("cancelled")).toBe("idle");
    expect(stage("rewound")).toBe("idle");
  });

  test("规则表缺口直接报错", () => {
    expect(() => stage("unknown" as TaskStatus)).toThrow("阶段规则表未覆盖");
  });
});
