import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getAdapter } from "../src/adapters";
import { loadPrompts } from "../src/prompts";
import type { Task } from "../src/types";

const task: Task = {
  id: "t_1",
  source: "test",
  channel: "cli",
  chatId: "c1",
  requester: "u1",
  repo: "demo",
  prompt: "修一下登录",
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
  prompts: loadPrompts(join(import.meta.dir, "..", "prompts")),
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

  test("提示词来自注入的 PromptSet，可通过覆盖段落改内容", () => {
    const custom = {
      ...input.prompts,
      segments: { ...input.prompts.segments, intro: "团队开场：任务 {{id}}" },
    };
    const args = getAdapter("omp").buildArgs({ ...input, prompts: custom });
    expect(args[args.indexOf("-p") + 1]).toContain("团队开场：任务 t_1");
    expect(args[args.indexOf("-p") + 1]).toContain("修一下登录");
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

  test("未知适配器直接报错", () => {
    expect(() => getAdapter("nope")).toThrow();
  });
});
