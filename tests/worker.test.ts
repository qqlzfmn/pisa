import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "../src/worker";
import type { Config } from "../src/config";
import type { Task } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "pisa-worker-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const task: Task = {
  id: "t_1",
  source: "test",
  channel: "cli",
  chatId: "c1",
  requester: "u1",
  repo: "demo",
  prompt: "评审分支",
  status: "running",
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

/** 假 agent：按脚本输出 stdout / stderr，退出码由脚本决定 */
function worker(name: string, body: string): Worker {
  const script = join(dir, `${name}.sh`);
  writeFileSync(script, `#!/bin/bash\n${body}\n`);
  chmodSync(script, 0o755);
  const cfg: Config["worker"] = {
    adapter: "omp",
    command: script,
    timeoutSec: 10,
    extraArgs: [],
    concurrency: 1,
  };
  return new Worker(cfg, join(dir, "state"));
}

const event = (text: string) =>
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("Worker 摘要", () => {
  test("只取最后一条 assistant 消息，不把过程闲聊拼进摘要", async () => {
    const w = worker(
      "chatter",
      [
        `printf '%s\\n' '${event("我先扫描仓库结构。")}'`,
        `printf '%s\\n' '${event("FAIL — 阻断：prUrl 未清空")}'`,
      ].join("\n"),
    );
    const r = await w.run(task, dir, () => {}, () => false);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("FAIL — 阻断：prUrl 未清空");
  });

  test("没有 assistant 消息时用原始输出兜底", async () => {
    const w = worker("raw", `echo 'boom: 进程异常' >&2`);
    const r = await w.run(task, dir, () => {}, () => false);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("boom: 进程异常");
  });
});
