import { afterEach, describe, expect, test } from "bun:test";
import { Store } from "../src/store";
import { startHealthServer, type HealthReport, type HealthServer } from "../src/health";
import type { Task, TaskStatus } from "../src/types";

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

let servers: HealthServer[] = [];
let stores: Store[] = [];

afterEach(() => {
  for (const s of servers) s.stop(true);
  for (const s of stores) {
    try {
      s.close();
    } catch {
      // 已在用例里关闭
    }
  }
  servers = [];
  stores = [];
});

function makeStore(): Store {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
}

function seed(store: Store, over: Partial<Task> & { id: string }): void {
  store.insertTask({
    source: `seed:${over.id}`,
    channel: "fake",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "任务",
    status: "queued" as TaskStatus,
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
    createdAt: NOW - HOUR,
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
    ...over,
  });
}

/** 落一条已结束的任务：queued → running → 终态，时间戳与真实路径一致 */
function seedFinished(store: Store, id: string, status: TaskStatus, startedAt: number, endedAt: number, repo = "demo"): void {
  seed(store, { id, repo, createdAt: startedAt });
  store.claimQueued(id, startedAt, `pisa/${id}`);
  store.transition(id, status, { endedAt });
}

function serve(store: Store): HealthServer {
  const server = startHealthServer({ store, port: 0, startedAt: NOW - 5000, now: () => NOW });
  servers.push(server);
  return server;
}

async function getHealth(server: HealthServer): Promise<{ status: number; body: HealthReport }> {
  const res = await fetch(`http://127.0.0.1:${server.port}/health`);
  return { status: res.status, body: (await res.json()) as HealthReport };
}

describe("GET /health", () => {
  test("空库返回可用快照", async () => {
    const { status, body } = await getHealth(serve(makeStore()));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.uptimeSec).toBe(5);
    expect(body.running).toBe(0);
    expect(body.queueDepth).toBe(0);
    expect(body.repos).toEqual([]);
    expect(body.last24h).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      successRate: null,
      p50Ms: null,
      p95Ms: null,
    });
  });

  test("24h 成功率与耗时分位", async () => {
    const store = makeStore();
    seedFinished(store, "a", "succeeded", NOW - 30_000, NOW - 20_000);
    seedFinished(store, "b", "succeeded", NOW - 40_000, NOW - 20_000);
    seedFinished(store, "c", "failed", NOW - 80_000, NOW - 20_000);

    const { body } = await getHealth(serve(store));
    expect(body.last24h.total).toBe(3);
    expect(body.last24h.succeeded).toBe(2);
    expect(body.last24h.failed).toBe(1);
    expect(body.last24h.successRate).toBe(0.667);
    expect(body.last24h.p50Ms).toBe(20_000);
    expect(body.last24h.p95Ms).toBe(60_000);
  });

  test("24 小时前结束的任务不计入，取消任务只计数", async () => {
    const store = makeStore();
    seedFinished(store, "old", "succeeded", NOW - 26 * HOUR, NOW - 25 * HOUR);
    seedFinished(store, "fresh", "succeeded", NOW - 20_000, NOW - 10_000);
    seed(store, { id: "cancel", status: "queued", createdAt: NOW - 3000 });
    store.transition("cancel", "cancelled", { endedAt: NOW - 2000 });

    const { body } = await getHealth(serve(store));
    expect(body.last24h.total).toBe(2);
    expect(body.last24h.succeeded).toBe(1);
    expect(body.last24h.cancelled).toBe(1);
    expect(body.last24h.successRate).toBe(1);
    expect(body.last24h.p50Ms).toBe(10_000);
  });

  test("每仓库运行中、排队与 24h 完成数，按仓库名升序", async () => {
    const store = makeStore();
    seed(store, { id: "run-beta", repo: "beta", status: "running", startedAt: NOW - 60_000 });
    seed(store, { id: "queue-alpha", repo: "alpha" });
    seedFinished(store, "done-alpha", "succeeded", NOW - 30_000, NOW - 10_000, "alpha");

    const { body } = await getHealth(serve(store));
    expect(body.running).toBe(1);
    expect(body.queueDepth).toBe(1);
    expect(body.repos).toEqual([
      { repo: "alpha", running: 0, queued: 1, finished24h: 1 },
      { repo: "beta", running: 1, queued: 0, finished24h: 0 },
    ]);
  });

  test("非 GET 返回 405，未知路径返回 404", async () => {
    const server = serve(makeStore());
    const post = await fetch(`http://127.0.0.1:${server.port}/health`, { method: "POST" });
    expect(post.status).toBe(405);
    const missing = await fetch(`http://127.0.0.1:${server.port}/other`);
    expect(missing.status).toBe(404);
  });

  test("存储不可用时返回 503 与错误信息", async () => {
    const store = makeStore();
    const server = serve(store);
    store.close();
    const { status, body } = await getHealth(server);
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });
});
