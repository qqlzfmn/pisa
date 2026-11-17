import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/types";
import { Worker, killRunningWorkers } from "../src/worker";

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

  test("关停时终止在跑的 Worker 进程组", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-worker-"));
    const worker = new Worker(
      {
        adapter: "omp",
        command: "bash",
        timeoutSec: 60,
        // 两个子进程先起来再报「就绪」，避免在 shell 还在 fork 的瞬间发信号
        extraArgs: ["-c", "sleep 20 & sleep 20 & echo up; wait"],
        concurrency: 1,
      },
      join(dir, "state"),
    );

    // 以子进程的第一行输出作为「已启动」信号，不用猜睡眠时长
    const { promise: started, resolve: onStarted } = Promise.withResolvers<void>();
    const startedAt = Date.now();
    const running = worker.run(
      task(),
      dir,
      () => onStarted(),
      () => false,
    );
    await started;
    killRunningWorkers();

    const result = await running;
    expect(result.ok).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(6000);
  }, 15_000);
});
