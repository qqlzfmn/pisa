import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/types";
import { Worker } from "../src/worker";

function task(): Task {
  return {
    id: "t_worker_child",
    source: "test:t_worker_child",
    channel: "test",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "长跑",
    status: "running",
    branch: "pisa/t_worker_child",
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
    startedAt: 0,
    endedAt: null,
    cancelRequested: false,
  };
}

describe("Worker 取消", () => {
  test("后台子进程占着输出管道也能及时返回", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-worker-"));
    const worker = new Worker(
      { adapter: "omp", command: "bash", timeoutSec: 60, extraArgs: ["-c", "sleep 20 & sleep 20"], concurrency: 1 },
      join(dir, "state"),
    );

    const startedAt = Date.now();
    const result = await worker.run(
      task(),
      dir,
      () => {},
      () => Date.now() - startedAt > 300,
    );

    expect(result.error).toBe("任务已取消");
    expect(Date.now() - startedAt).toBeLessThan(6000);
  }, 15_000);
});
