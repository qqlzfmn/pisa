import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEB, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { ReplyBus, WEB_COOKIE, createWebApp } from "../src/web";
import type { ChannelAdapter, DeliveryReceipt, Task, TaskStatus, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh } from "../src/git";

class FakeChannel implements ChannelAdapter {
  name = "fake";
  async start(): Promise<void> {}
  async send(): Promise<DeliveryReceipt> {
    return { messageId: "1" };
  }
  async stop(): Promise<void> {}
}

const okWorker: WorkerRunner = {
  async run(_task, workdir): Promise<WorkerResult> {
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    return { ok: true, summary: "改了 out.txt", exitCode: 0 };
  },
};

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-mgmt-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

const TOKEN = "mgmt-token";

interface StateBody {
  ok: boolean;
  daemon: { alive: boolean; ageMs: number | null };
  executor: { paused: boolean; active: number; concurrency: number };
  counts: Record<TaskStatus, number>;
  total: number;
  repos: string[];
  running: Array<{ id: string; status: TaskStatus }>;
  queued: Array<{ id: string; status: TaskStatus }>;
  finished: Array<{ id: string; status: TaskStatus }>;
  last24h: { finished: number; succeeded: number };
}

interface TicketBody {
  ok: boolean;
  task: { id: string; status: TaskStatus; prompt: string; branch: string | null; repo: string };
  effects: Array<{ kind: string }>;
  logTail: string[];
}

interface ListBody {
  ok: boolean;
  tickets: Array<{ id: string; status: TaskStatus }>;
}

interface ErrorBody {
  ok: boolean;
  code: string;
  error: string;
}

interface CreateBody {
  ok: boolean;
  taskId: string;
  task: { id: string; status: TaskStatus; prompt: string };
  message: string;
}

interface ActionBody {
  ok: boolean;
  status: TaskStatus | null;
  message: string;
  restart?: "auto" | "manual";
  taskId?: string | null;
}

describe("管理 API", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let cfg: Config;
  let router: Router;
  let app: (req: Request) => Promise<Response>;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-mgmt-state-"));
    store = new Store(":memory:");
    store.beat(Date.now());
    cfg = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: ["u1"], repos: ["demo"] },
      repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      web: { ...DEFAULT_WEB, enabled: true, userId: "u1", chatId: "web" },
      stateDir,
    };
    const bus = new ReplyBus("web", new FakeChannel());
    router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
    app = createWebApp({ cfg, store, router, bus, token: TOKEN });
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function seed(over: Partial<Task> & { id: string }): Task {
    const { id, ...rest } = over;
    const task: Task = {
      id,
      source: `seed:${id}`,
      channel: "api",
      chatId: "web",
      requester: "u1",
      repo: "demo",
      prompt: "既有任务",
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
      ...rest,
    };
    store.insertTask(task);
    return task;
  }

  /** insertTask 不写结束时间：跑完状态机，指标与上下文才拿得到终态字段 */
  function finish(id: string, to: TaskStatus, patch: Partial<Task> = {}): Task {
    store.claimQueued(id, Date.now(), patch.branch ?? `pisa/${id}`);
    store.transition(id, to, { endedAt: Date.now(), ...patch });
    return store.get(id)!;
  }

  const auth = { "x-pisa-token": TOKEN };

  function call(path: string, init: RequestInit = {}): Promise<Response> {
    return app(new Request(`http://127.0.0.1:8787${path}`, init));
  }

  function post(path: string, body?: unknown): Promise<Response> {
    return call(path, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  describe("鉴权与来源", () => {
    test("无凭证、query token、cookie 一律 401", async () => {
      const attempts: RequestInit[] = [
        {},
        { headers: { cookie: `${WEB_COOKIE}=${TOKEN}` } },
        { headers: { cookie: `${WEB_COOKIE}=` } },
        { headers: { "x-pisa-token": "wrong" } },
        { headers: { authorization: "Bearer wrong" } },
      ];
      for (const init of attempts) {
        const res = await call("/state", init);
        expect(res.status).toBe(401);
        expect(((await res.json()) as ErrorBody).code).toBe("auth");
      }
      expect((await call(`/state?token=${TOKEN}`)).status).toBe(401);
    });

    test("Bearer 与 x-pisa-token 都放行", async () => {
      expect((await call("/state", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
      expect((await call("/tickets", { headers: auth })).status).toBe(200);
    });

    test("Host 不是回环时 403", async () => {
      const res = await call("/state", { headers: { ...auth, host: "evil.example" } });
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorBody).code).toBe("auth");
    });

    test("未知管理路径 404，方法不对 405", async () => {
      expect((await call("/tickets/t_x/explode", { headers: auth })).status).toBe(404);
      expect((await call("/state", { method: "POST", headers: auth })).status).toBe(405);
    });
  });

  describe("查询", () => {
    test("GET /state 返回执行器、计数与看板", async () => {
      seed({ id: "t_state_run", status: "running" });
      seed({ id: "t_state_done" });
      finish("t_state_done", "succeeded");
      const body = (await (await call("/state", { headers: auth })).json()) as StateBody;
      expect(body.ok).toBe(true);
      expect(body.daemon.alive).toBe(true);
      expect(body.executor).toEqual({ paused: false, active: 0, concurrency: 1 });
      expect(body.counts.running).toBe(1);
      expect(body.running.map((t) => t.id)).toEqual(["t_state_run"]);
      expect(body.finished.map((t) => t.id)).toEqual(["t_state_done"]);
      expect(body.repos).toEqual(["demo"]);
      expect(body.last24h.finished).toBe(1);
    });

    test("GET /tickets 过滤状态与仓库", async () => {
      seed({ id: "t_list_a" });
      seed({ id: "t_list_b", status: "failed" });
      const all = (await (await call("/tickets", { headers: auth })).json()) as ListBody;
      expect(all.tickets).toHaveLength(2);
      const failed = (await (await call("/tickets?status=failed", { headers: auth })).json()) as ListBody;
      expect(failed.tickets.map((t) => t.id)).toEqual(["t_list_b"]);
      const bad = await call("/tickets?status=nope", { headers: auth });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as ErrorBody).code).toBe("usage");
    });

    test("GET /tickets/:id 带副作用与日志，缺失 404", async () => {
      seed({ id: "t_detail", status: "succeeded", branch: "pisa/t_detail", summary: "完成" });
      store.effect("t_detail", "branch", "pisa/t_detail", null);
      const body = (await (await call("/tickets/t_detail", { headers: auth })).json()) as TicketBody;
      expect(body.task.id).toBe("t_detail");
      expect(body.effects.map((e) => e.kind)).toEqual(["branch"]);
      expect(body.logTail).toEqual([]);
      expect((await call("/tickets/t_missing", { headers: auth })).status).toBe(404);
      expect((await call("/tickets/t_detail?logTail=abc", { headers: auth })).status).toBe(400);
    });
  });

  describe("派活与操作", () => {
    test("POST /tickets 入队，空正文字段错误", async () => {
      const res = await post("/tickets", { prompt: "整理 README" });
      const body = (await res.json()) as CreateBody;
      expect(res.status).toBe(200);
      expect(body.task.prompt).toBe("整理 README");
      expect(store.get(body.taskId)?.status).toBe("queued");
      const empty = await post("/tickets", { prompt: "  " });
      expect(empty.status).toBe(400);
      expect(((await empty.json()) as ErrorBody).code).toBe("usage");
    });

    test("POST /tickets 未知仓库属于待配置", async () => {
      const res = await post("/tickets", { prompt: "x", repo: "nope" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).code).toBe("config");
    });

    test("POST stop 取消排队任务，终态任务 409", async () => {
      seed({ id: "t_stop_queued" });
      const res = await post("/tickets/t_stop_queued/stop");
      expect(res.status).toBe(200);
      expect(store.get("t_stop_queued")!.status).toBe("cancelled");
      seed({ id: "t_stop_done", status: "succeeded" });
      expect((await post("/tickets/t_stop_done/stop")).status).toBe(409);
      expect((await post("/tickets/t_none/stop")).status).toBe(409);
    });

    test("POST retry 用同需求新建任务且不带旧分支", async () => {
      seed({ id: "t_retry_src", prompt: "修 bug" });
      finish("t_retry_src", "failed", { error: "测试失败" });
      const res = await post("/tickets/t_retry_src/retry");
      const body = (await res.json()) as ActionBody;
      expect(res.status).toBe(200);
      const task = store.get(body.taskId!)!;
      expect(task.prompt).toBe("修 bug");
      expect(task.repo).toBe("demo");
      expect(task.status).toBe("queued");
      expect(task.branch).toBeNull();
      expect(task.context).toContain("t_retry_src");
      expect(task.context).toContain("测试失败");
    });

    test("POST retry 拒绝运行中的任务", async () => {
      seed({ id: "t_retry_run", status: "running" });
      const res = await post("/tickets/t_retry_run/retry");
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).code).toBe("state");
    });

    test("POST executor/pause 拦住出队，恢复后继续", async () => {
      seed({ id: "t_pause" });
      const paused = (await (await post("/executor/pause", { paused: true })).json()) as {
        executor: { paused: boolean };
      };
      expect(paused.executor.paused).toBe(true);
      expect(await router.drainOnce()).toBe(false);
      expect(store.get("t_pause")!.status).toBe("queued");
      expect(((await (await call("/state", { headers: auth })).json()) as StateBody).executor.paused).toBe(true);

      await post("/executor/pause", { paused: false });
      expect(await router.drainOnce()).toBe(true);
      expect(store.get("t_pause")!.status).toBe("succeeded");
      const bad = await post("/executor/pause", { paused: "yes" });
      expect(bad.status).toBe(400);
    });

    test("POST merge 需要 confirm，成功后报告 restart", async () => {
      const supervised = process.env.PISA_SUPERVISED;
      delete process.env.PISA_SUPERVISED;
      try {
        const created = (await (await post("/tickets", { prompt: "新建 out.txt" })).json()) as CreateBody;
        await router.drainOnce();
        expect((await post(`/tickets/${created.taskId}/merge`, {})).status).toBe(400);
        const res = await post(`/tickets/${created.taskId}/merge`, { confirm: true });
        const body = (await res.json()) as ActionBody;
        expect(res.status).toBe(200);
        expect(body.restart).toBe("manual");
        expect(store.effectsOf(created.taskId).some((e) => e.kind === "merge")).toBe(true);
      } finally {
        if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
      }
    });

    test("POST merge 未成功的任务 409", async () => {
      seed({ id: "t_merge_queued" });
      expect((await post("/tickets/t_merge_queued/merge", { confirm: true })).status).toBe(409);
    });

    test("POST rewind 默认只预览", async () => {
      seed({ id: "t_rewind", status: "succeeded", branch: "pisa/t_rewind" });
      const res = await post("/tickets/t_rewind/rewind", {});
      const body = (await res.json()) as ActionBody & { applied: boolean };
      expect(res.status).toBe(200);
      expect(body.applied).toBe(false);
      expect(store.get("t_rewind")!.status).toBe("succeeded");
    });
  });
});
