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
  prompt: "CUSTOM PROMPT",
  cfg: { adapter: "omp", command: "omp", timeoutSec: 60, extraArgs: [], concurrency: 1 },
};

describe("WorkerAdapter", () => {
  test("omp 参数包含任务、工作目录与扩展", () => {
    const args = getAdapter("omp").buildArgs(input);
    expect(args[0]).toBe("omp");
    expect(args).toContain("--cwd");
    expect(args[args.indexOf("--cwd") + 1]).toBe("/tmp/wt");
    expect(args[args.indexOf("-p") + 1]).toBe("CUSTOM PROMPT");
    expect(args).toContain("-e");
  });

  test("恢复会话时带 -r <id>，位于 --mode=json 之前", () => {
    const args = getAdapter("omp").buildArgs({ ...input, resume: true, resumeSessionId: "sess-9" });
    const at = args.indexOf("-r");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe("sess-9");
    expect(at).toBeLessThan(args.indexOf("--mode=json"));
  });

  test("恢复标记与是否有会话 id 无关", () => {
    const args = getAdapter("omp").buildArgs({ ...input, resume: true, resumeSessionId: null });
    expect(args).not.toContain("-r");
    expect(args[args.indexOf("-p") + 1]).toBe("CUSTOM PROMPT");
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
