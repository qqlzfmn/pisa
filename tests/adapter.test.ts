import { describe, expect, test } from "bun:test";
import { getAdapter } from "../src/adapters";
import type { Task } from "../src/types";

const task: Task = {
  id: "t_1",
  source: "test",
  channel: "cli",
  chatId: "c1",
  requester: "u1",
  repo: "demo",
  prompt: "修一下登录",
  mode: "work",
  status: "queued",
  branch: null,
  prUrl: null,
  sessionId: null,
  baseRef: null,
  context: null,
  replyPr: null,
  replyIssue: null,
  replyRepo: null,
  summary: null,
  error: null,
  createdAt: 0,
  startedAt: null,
  endedAt: null,
  cancelRequested: false,
};

const input = {
  task,
  workdir: "/tmp/wt",
  extensionPath: "/tmp/ext.ts",
  progressFile: "/tmp/p.jsonl",
  cfg: { adapter: "omp", command: "omp", timeoutSec: 60, extraArgs: [], concurrency: 1 },
};

describe("WorkerAdapter", () => {
  test("omp 参数包含任务、工作目录与扩展", () => {
    const args = getAdapter("omp").buildArgs(input);
    expect(args[0]).toBe("omp");
    expect(args).toContain("--cwd");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/tmp/wt");
    expect(args[args.indexOf("-p") + 1]).toContain("修一下登录");
    expect(args).toContain("-e");
  });

  test("恢复会话时带 -r <id>，位于 --mode=json 之前", () => {
    const args = getAdapter("omp").buildArgs({ ...input, resumeSessionId: "sess-9" });
    const at = args.indexOf("-r");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe("sess-9");
    expect(at).toBeLessThan(args.indexOf("--mode=json"));
    expect(args[args.indexOf("-p") + 1]).toContain("上一次执行被中断");
  });

  test("新任务不带 -r，提示词也没有恢复段", () => {
    const args = getAdapter("omp").buildArgs(input);
    expect(args).not.toContain("-r");
    expect(args[args.indexOf("-p") + 1]).not.toContain("上一次执行被中断");
  });

  test("只取 assistant 的 message_end", () => {
    const a = getAdapter("omp");
    const ok = a.parseLine(
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ text: "改好了" }] } }),
    );
    expect(ok.text).toBe("改好了");
    const user = a.parseLine(
      JSON.stringify({ type: "message_end", message: { role: "user", content: [{ text: "修一下登录" }] } }),
    );
    expect(user.text).toBeUndefined();
    expect(a.parseLine("not json").raw).toBe("not json");
  });

  test("评审任务：只读约束代替写代码约束，并设置 PISA_READONLY", () => {
    const review = { ...input, task: { ...task, mode: "review" as const } };
    const a = getAdapter("omp");
    const prompt = a.buildArgs(review)[a.buildArgs(review).indexOf("-p") + 1]!;
    expect(prompt).toContain("只读评审");
    expect(prompt).toContain("PISA_READONLY");
    expect(prompt).not.toContain("不要执行 git commit / git push / git checkout 主分支");
    expect(prompt).not.toContain("完成后用中文给出");
    expect(a.buildEnv(input).PISA_READONLY).toBeUndefined();
  });

  test("评审任务的环境带 PISA_READONLY=1", () => {
    const env = getAdapter("omp").buildEnv({ ...input, task: { ...task, mode: "review" } });
    expect(env.PISA_READONLY).toBe("1");
    expect(env.PISA_WORKDIR).toBe("/tmp/wt");
  });

  test("未知适配器直接报错", () => {
    expect(() => getAdapter("nope")).toThrow();
  });
});
