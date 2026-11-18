import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEB, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { createWebApp, startWebServer } from "../src/web";
import { ReplyBus } from "../src/reply-bus";
import type { Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh } from "../src/git";
import { newTaskId } from "../src/ids";

const TOKEN = "abc123";
const USER = "u1";

const okWorker: WorkerRunner = {
  async run(): Promise<WorkerResult> {
    return { ok: true, summary: "", exitCode: 0 };
  },
};

let root: string;
let repo: string;
let store: Store;
let app: (req: Request) => Promise<Response> | Response;

function makeRepo(): string {
  const dir = join(root, "repo");
  mkdirSync(dir);
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function makeCfg(): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: [USER], repos: ["demo"] },
    repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    web: { ...DEFAULT_WEB, enabled: false, userId: USER, chatId: "web" },
    stateDir: join(root, ".pisa"),
  };
}

function seed(over: Partial<Task> = {}): Task {
  const task: Task = {
    id: newTaskId(),
    source: "cli",
    channel: "web",
    chatId: "web",
    requester: USER,
    repo: "demo",
    prompt: "任务",
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
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
    ...over,
  };
  store.insertTask(task);
  return task;
}

type Json = Record<string, any>;

async function call(method: string, path: string, init: { token?: string | null; host?: string; body?: unknown; cookie?: string } = {}): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers["x-pisa-token"] = init.token ?? TOKEN;
  if (init.host) headers.host = init.host;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.cookie) headers.cookie = `pisa_web=${init.cookie}`;
  const res = await app(
    new Request(`http://127.0.0.1:8787${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pisa-api-"));
  repo = makeRepo();
  const cfg = makeCfg();
  store = new Store(":memory:");
  const bus = new ReplyBus("web");
  const router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
  app = createWebApp({ cfg, store, router, bus, token: TOKEN, ui: false });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("鉴权只认请求头", () => {
  test("缺 token、查询串 token、cookie 都拒绝", async () => {
    expect((await call("GET", "/state", { token: null })).status).toBe(401);
    expect((await call("GET", `/state?token=${TOKEN}`, { token: null })).status).toBe(401);
    expect((await call("GET", `/state?token=${TOKEN}`, { token: null, cookie: TOKEN })).status).toBe(401);
    const wrong = await call("GET", "/state", { token: "nope" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("未授权");
  });

  test("x-pisa-token 与 Bearer 都放行", async () => {
    expect((await call("GET", "/state")).status).toBe(200);
    const res = await app(new Request("http://127.0.0.1:8787/state", { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(200);
  });

  test("非本机 Host 一律 403，路径与 token 也不再泄露信息", async () => {
    const res = await call("GET", "/state", { host: "evil.example:8787" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("只接受本机请求");
  });

  test("非管理路径不受影响，仍走控制台鉴权", async () => {
    const res = await call("GET", "/nope", { token: null });
    expect(res.status).toBe(401);
  });
});

describe("状态与工单", () => {
  test("GET /state 返回执行器、计数与队列投影", async () => {
    store.beat();
    seed({ prompt: "排队中" });
    seed({ status: "succeeded", prompt: "完成", summary: "好" });

    const { status, body } = await call("GET", "/state");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.daemon.alive).toBe(true);
    expect(body.executor).toMatchObject({ paused: false, running: 0, queued: 1, concurrency: 1 });
    expect(body.counts).toMatchObject({ queued: 1, succeeded: 1 });
    expect(body.total).toBe(2);
    expect(body.queued[0]).toMatchObject({ prompt: "排队中", status: "queued", stageLabel: "等空闲槽位" });
    expect(body.finished[0]).toMatchObject({ prompt: "完成", statusLabel: "成功" });
    expect(body.last24h.finished).toBe(1);
  });

  test("GET /tickets/:id 返回任务、副作用与日志尾部", async () => {
    const task = seed({ status: "running", startedAt: Date.now() });
    store.transition(task.id, "failed", { error: "编译失败", endedAt: Date.now() });
    store.effect(task.id, "branch", "pisa/x", JSON.stringify({ from: "main" }));
    const logDir = join(root, ".pisa", "logs");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, `${task.id}.log`), `${JSON.stringify({ ts: 0, stage: "working", msg: "跑测试" })}\n`);

    const { status, body } = await call("GET", `/tickets/${task.id}`);
    expect(status).toBe(200);
    expect(body.task).toMatchObject({ id: task.id, status: "failed", error: "编译失败" });
    expect(body.effects.map((e: Json) => e.kind)).toEqual(["branch"]);
    expect(body.logTail).toHaveLength(1);
    expect(body.logTail[0]).toContain("working 跑测试");

    expect((await call("GET", "/tickets/t_missing")).status).toBe(404);
  });

  test("方法不符返回 405 并带 allow", async () => {
    expect((await call("POST", "/state")).status).toBe(405);
    expect((await call("GET", "/executor/pause")).status).toBe(405);
    expect((await call("GET", "/tickets/t_x/stop")).status).toBe(405);
  });
});

describe("动作", () => {
  test("executor pause/resume 落库并反映到状态", async () => {
    const paused = await call("POST", "/executor/pause");
    expect(paused.status).toBe(200);
    expect(paused.body.executor.paused).toBe(true);
    expect(store.executorPaused()).toBe(true);
    expect((await call("GET", "/state")).body.executor.paused).toBe(true);

    const resumed = await call("POST", "/executor/resume");
    expect(resumed.body.executor.paused).toBe(false);
    expect(store.executorPaused()).toBe(false);
  });

  test("stop 排队任务成功，终态任务返回 409", async () => {
    const queued = seed();
    const res = await call("POST", `/tickets/${queued.id}/stop`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(store.get(queued.id)!.status).toBe("cancelled");

    const done = seed({ status: "succeeded" });
    const conflict = await call("POST", `/tickets/${done.id}/stop`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.ok).toBe(false);
  });

  test("retry 只接受失败或取消的任务，新任务复用原分支", async () => {
    const failed = seed({ status: "failed", branch: "pisa/orig", prompt: "原需求", summary: null });
    const res = await call("POST", `/tickets/${failed.id}/retry`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const next = store.get(res.body.taskId)!;
    expect(next.id).not.toBe(failed.id);
    expect(next.baseRef).toBe("pisa/orig");
    expect(next.prompt).toBe("原需求");
    expect(next.status).toBe("queued");

    const ok = seed({ status: "succeeded" });
    expect((await call("POST", `/tickets/${ok.id}/retry`)).status).toBe(409);
    expect((await call("POST", "/tickets/t_missing/retry")).status).toBe(404);
  });

  test("retry 无分支按原需求新开任务", async () => {
    const failed = seed({ status: "cancelled", prompt: "从零再来" });
    const res = await call("POST", `/tickets/${failed.id}/retry`);
    expect(res.status).toBe(200);
    const next = store.get(res.body.taskId)!;
    expect(next.baseRef).toBeNull();
    expect(next.prompt).toBe("从零再来");
  });

  test("merge 要求显式 confirm", async () => {
    const task = seed({ status: "succeeded", branch: "pisa/done" });
    expect((await call("POST", `/tickets/${task.id}/merge`)).status).toBe(400);
    expect((await call("POST", "/tickets/t_missing/merge", { body: { confirm: true } })).status).toBe(404);
    const conflict = await call("POST", `/tickets/${task.id}/merge`, { body: { confirm: true } });
    expect(conflict.status).toBe(409);
  });

  test("rewind 默认只给计划，apply 后落库为 rewound", async () => {
    const task = seed({ status: "succeeded" });
    const preview = await call("POST", `/tickets/${task.id}/rewind`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.plan.task.id).toBe(task.id);
    expect(store.get(task.id)!.status).toBe("succeeded");

    const applied = await call("POST", `/tickets/${task.id}/rewind`, { body: { apply: true } });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(store.get(task.id)!.status).toBe("rewound");
    expect((await call("POST", `/tickets/${task.id}/rewind`, { body: { apply: true } })).status).toBe(409);
  });
});

describe("控制面服务", () => {
  test("控制台关闭且端口被占用时退回系统分配的端口", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
    const cfg = makeCfg();
    mkdirSync(cfg.stateDir, { recursive: true });
    const bus = new ReplyBus("web");
    const router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
    const server = startWebServer({ cfg, store, router, bus }, { ...cfg.web!, enabled: false, port: blocker.port! });
    try {
      expect(server.server.port).not.toBe(blocker.port);
      const res = await fetch(`${server.apiUrl}/state`, { headers: { "x-pisa-token": server.token } });
      expect(res.status).toBe(200);
      const saved = JSON.parse(readFileSync(join(cfg.stateDir, "api.json"), "utf8")) as { url: string; token: string; pid: number };
      expect(saved).toEqual({ url: server.apiUrl, token: server.token, pid: process.pid });
    } finally {
      await server.stop();
      blocker.stop(true);
    }
  });
});
