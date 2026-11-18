import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEB, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { ReplyBus, createWebApp, type WebDeps } from "../src/web";
import type { ChannelAdapter, DeliveryReceipt, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh } from "../src/git";

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: Array<{ chatId: string; text: string }> = [];
  async start(): Promise<void> {}
  async send(chatId: string, text: string): Promise<DeliveryReceipt> {
    this.sent.push({ chatId, text });
    return { messageId: String(this.sent.length) };
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
  const dir = mkdtempSync(join(tmpdir(), "pisa-web-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function makeCfg(repoPath: string, stateDir: string): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: repoPath, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    web: { ...DEFAULT_WEB, enabled: true, userId: "u1", chatId: "web" },
    stateDir,
  };
}

const TOKEN = "abc123";

interface StateResponse {
  ok: boolean;
  daemon: { alive: boolean; ageMs: number | null };
  executor: { paused: boolean; concurrency: number; active: number };
  counts: Record<string, number>;
  repos: Array<{ alias: string; path: string; remote: string | null; baseBranch: string | null; allowed: boolean }>;
  repo: string | null;
  running: Array<{ id: string; prompt: string; statusLabel: string; stage: string; stageLabel: string }>;
  queued: Array<{ id: string; prompt: string; stage: string }>;
  finished: Array<{ id: string; statusLabel: string; stage: string }>;
}

interface DetailResponse {
  ok: boolean;
  ticket: { id: string; prompt: string; duration: string; branch: string | null; stage: string; stageLabel: string };
  effects: Array<{ kind: string; target: string }>;
  logTail: string[];
}

interface SubmitResponse {
  ok: boolean;
  ticketId: string | null;
  message: string;
  error?: string;
}

interface ActionResponse {
  ok: boolean;
  ticket: { id: string; status: string } | null;
  message: string;
  restartRequired?: boolean;
  applied?: boolean;
}

describe("管理接口", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let down: FakeChannel;
  let bus: ReplyBus;
  let cfg: Config;
  let router: Router;
  let app: (req: Request) => Promise<Response>;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-web-state-"));
    store = new Store(":memory:");
    down = new FakeChannel();
    bus = new ReplyBus("web", down);
    cfg = makeCfg(repo, stateDir);
    router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
    const deps: WebDeps = { cfg, store, router, bus, token: TOKEN };
    app = createWebApp(deps);
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** 直接落一条任务，构造看板与非法状态场景 */
  function seedTask(over: Partial<Task> & { id: string }): Task {
    const { id, ...rest } = over;
    const task: Task = {
      id,
      source: `seed:${id}`,
      channel: "fake",
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

  const auth = { authorization: `Bearer ${TOKEN}` };

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

  describe("鉴权", () => {
    test("无凭证 401", async () => {
      for (const [path, method] of [
        ["/ui", "GET"],
        ["/state", "GET"],
        ["/tickets", "GET"],
        ["/tickets", "POST"],
        ["/tickets/t_x/stop", "POST"],
        ["/executor/pause", "POST"],
      ] as const) {
        const res = await call(path, { method, body: method === "POST" ? "{}" : undefined });
        expect(res.status).toBe(401);
      }
      expect(store.recentTasks()).toHaveLength(0);
    });

    test("错误 token 401", async () => {
      const res = await call("/state", { headers: { authorization: "Bearer wrong" } });
      expect(res.status).toBe(401);
    });

    test("Bearer 与专用头放行，cookie 与查询参数不放行", async () => {
      expect((await call("/state", { headers: auth })).status).toBe(200);
      expect((await call("/state", { headers: { "x-pisa-token": TOKEN } })).status).toBe(200);
      expect((await call("/state", { headers: { cookie: `pisa_web=${TOKEN}` } })).status).toBe(401);
      expect((await call(`/state?token=${TOKEN}`)).status).toBe(401);
    });

    test("/ui?token= 直接返回页面，不再下发 cookie", async () => {
      const res = await call(`/ui?token=${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).toContain("pisa 控制台");
    });

    test("/ 跳转到 /ui", async () => {
      const res = await call(`/?token=${TOKEN}`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/ui");
    });

    test("未开启控制台时 /ui 404", async () => {
      const disabled = makeCfg(repo, stateDir);
      cfg = { ...disabled, web: { ...disabled.web!, enabled: false } };
      const router2 = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
      const app2 = createWebApp({ cfg, store, router: router2, bus, token: TOKEN });
      expect((await app2(new Request(`http://127.0.0.1:8787/ui?token=${TOKEN}`))).status).toBe(404);
      // API 不受 web.enabled 影响
      expect((await app2(new Request("http://127.0.0.1:8787/state", { headers: auth }))).status).toBe(200);
    });

    test("不支持的方法 405", async () => {
      const res = await call("/tickets", { method: "PUT", headers: auth });
      expect(res.status).toBe(405);
    });
  });

  describe("状态", () => {
    test("三组任务、计数、仓库与执行器状态", async () => {
      seedTask({ id: "t_queue", status: "queued", prompt: "排队中" });
      seedTask({ id: "t_run", status: "running", startedAt: 1000, prompt: "跑着" });
      seedTask({ id: "t_ok", status: "succeeded", endedAt: 2000, prompt: "完成" });
      seedTask({ id: "t_other", status: "queued", repo: "other", prompt: "别的仓库" });
      store.beat();

      const res = await call("/state", { headers: auth });
      const body = (await res.json()) as StateResponse;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.repos).toEqual([{ alias: "demo", path: repo, remote: null, baseBranch: "main", allowed: true }]);
      expect(body.daemon.alive).toBe(true);
      expect(body.executor).toEqual({ paused: false, concurrency: 1, active: 0 });
      expect(body.counts.running).toBe(1);
      expect(body.running.map((t) => t.id)).toEqual(["t_run"]);
      expect(body.running[0]!.statusLabel).toBe("运行中");
      expect(body.running[0]!.stage).toBe("working");
      expect(body.queued.map((t) => t.id).sort()).toEqual(["t_other", "t_queue"]);
      expect(body.finished.map((t) => t.id)).toEqual(["t_ok"]);

      const filtered = (await (await call("/state?repo=demo", { headers: auth })).json()) as StateResponse;
      expect(filtered.repo).toBe("demo");
      expect(filtered.queued.map((t) => t.id)).toEqual(["t_queue"]);
    });

    test("详情带 prompt、字段与日志尾部", async () => {
      const task = seedTask({ id: "t_detail", status: "queued", prompt: "看日志" });
      // insertTask 不写 started_at，时间戳只能经状态跃迁设置
      store.transition(task.id, "running", { startedAt: Date.now() - 5000 });
      mkdirSync(join(stateDir, "logs"), { recursive: true });
      writeFileSync(
        join(stateDir, "logs", `${task.id}.log`),
        `${[
          JSON.stringify({ ts: 1_700_000_000_000, stage: "worker", msg: "开始执行" }),
          JSON.stringify({ ts: 1_700_000_001_000, stage: "deliver", msg: "推送完成" }),
          "不是 JSON 的行",
        ].join("\n")}\n`,
      );

      const res = await call(`/tickets/${task.id}`, { headers: auth });
      const body = (await res.json()) as DetailResponse;
      expect(res.status).toBe(200);
      expect(body.ticket.prompt).toBe("看日志");
      expect(body.ticket.stage).toBe("working");
      expect(body.ticket.stageLabel).toBe("执行中");
      expect(body.ticket.duration).toMatch(/^\d+s$/);
      expect(body.logTail).toHaveLength(3);
      expect(body.logTail[0]).toMatch(/^\d{2}:\d{2}:\d{2} worker 开始执行$/);
      expect(body.logTail[1]).toContain("deliver 推送完成");
      expect(body.logTail[2]).toBe("不是 JSON 的行");

      expect((await call("/tickets/t_missing", { headers: auth })).status).toBe(404);
    });

    test("logs 返回原始行并支持 tail", async () => {
      const task = seedTask({ id: "t_logs" });
      mkdirSync(join(stateDir, "logs"), { recursive: true });
      writeFileSync(join(stateDir, "logs", `${task.id}.log`), ["a", "b", "c"].join("\n") + "\n");
      const body = (await (await call(`/tickets/${task.id}/logs?tail=2`, { headers: auth })).json()) as {
        lines: string[];
        ticketId: string;
      };
      expect(body.ticketId).toBe(task.id);
      expect(body.lines).toEqual(["b", "c"]);
      expect((await call("/tickets/t_missing/logs", { headers: auth })).status).toBe(404);
    });
  });

  describe("清单", () => {
    test("状态过滤与非法状态", async () => {
      seedTask({ id: "t_a", status: "queued" });
      seedTask({ id: "t_b", status: "succeeded" });
      const body = (await (await call("/tickets?status=queued", { headers: auth })).json()) as {
        tickets: Array<{ id: string }>;
      };
      expect(body.tickets.map((t) => t.id)).toEqual(["t_a"]);
      const bad = await call("/tickets?status=nope", { headers: auth });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toContain("未知状态");
    });
  });

  describe("派活", () => {
    test("落库为排队任务并返回任务号", async () => {
      const res = await post("/tickets", { prompt: "修复登录跳转" });
      const body = (await res.json()) as SubmitResponse;
      expect(res.status).toBe(200);
      expect(body.ticketId).toBeTruthy();
      const task = store.get(body.ticketId!)!;
      expect(task.status).toBe("queued");
      expect(task.prompt).toBe("修复登录跳转");
      expect(task.requester).toBe("u1");
      expect(task.channel).toBe("web");
      expect(task.repo).toBe("demo");
      // 回执被总线收走，没有漏到真实通道
      expect(down.sent).toHaveLength(0);
    });

    test("eventId 重投落到同一个任务", async () => {
      const first = (await (await post("/tickets", { prompt: "幂等", eventId: "e1" })).json()) as SubmitResponse;
      const second = (await (await post("/tickets", { prompt: "幂等", eventId: "e1" })).json()) as SubmitResponse;
      expect(second.ticketId).toBe(first.ticketId!);
      expect(store.recentTasks()).toHaveLength(1);
    });

    test("空 prompt 400，不落库", async () => {
      const res = await post("/tickets", { prompt: "   " });
      expect(res.status).toBe(400);
      expect(store.recentTasks()).toHaveLength(0);
    });

    test("越权仓库返回 400 且带 config 错误码", async () => {
      cfg.whitelist.repos = ["other"];
      const res = await post("/tickets", { prompt: "不该进来" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code?: string }).code).toBe("config");
      expect(store.recentTasks()).toHaveLength(0);
    });

    test("单英文词不被误触防护拦下", async () => {
      const body = (await (await post("/tickets", { prompt: "refactor" })).json()) as SubmitResponse;
      expect(body.ticketId).toBeTruthy();
      expect(store.get(body.ticketId!)!.status).toBe("queued");
    });
  });

  describe("动作", () => {
    test("停止排队任务", async () => {
      seedTask({ id: "t_stop", status: "queued" });
      const body = (await (await post("/tickets/t_stop/stop")).json()) as ActionResponse;
      expect(body.ok).toBe(true);
      expect(body.ticket!.status).toBe("cancelled");
      expect((await post("/tickets/t_missing/stop")).status).toBe(404);
    });

    test("重试失败任务重新排队并清掉错误", async () => {
      seedTask({ id: "t_failed", status: "queued" });
      store.transition("t_failed", "running", { startedAt: 1 });
      store.transition("t_failed", "failed", { error: "炸了", endedAt: 2 });
      const res = await post("/tickets/t_failed/retry");
      const body = (await res.json()) as ActionResponse;
      expect(res.status).toBe(200);
      expect(body.ticket!.status).toBe("queued");
      expect(store.get("t_failed")!.error).toBeNull();
    });

    test("重试成功任务冲突", async () => {
      seedTask({ id: "t_done", status: "succeeded" });
      expect((await post("/tickets/t_done/retry")).status).toBe(409);
    });

    test("重试中断任务需要工作副本", async () => {
      seedTask({ id: "t_paused", status: "queued" });
      store.transition("t_paused", "running", { startedAt: 1 });
      store.transition("t_paused", "paused");
      expect((await post("/tickets/t_paused/retry")).status).toBe(409);
    });

    test("暂停执行器后不再领取排队任务，恢复后领取", async () => {
      seedTask({ id: "t_waiting", status: "queued" });
      const paused = (await (await post("/executor/pause")).json()) as { executor: { paused: boolean } };
      expect(paused.executor.paused).toBe(true);
      await router.drainOnce();
      expect(store.get("t_waiting")!.status).toBe("queued");

      const resumed = (await (await post("/executor/resume")).json()) as { executor: { paused: boolean } };
      expect(resumed.executor.paused).toBe(false);
      await router.drainOnce();
      expect(store.get("t_waiting")!.status).toBe("succeeded");
    });
  });

  describe("合并", () => {
    async function finishedTask(): Promise<string> {
      const body = (await (await post("/tickets", { prompt: "新建 out.txt" })).json()) as SubmitResponse;
      await router.drainOnce();
      return body.ticketId!;
    }

    test("缺少 confirm 时 400，且不动主干", async () => {
      const id = await finishedTask();
      const res = await post(`/tickets/${id}/merge`, {});
      expect(res.status).toBe(400);
      expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).not.toBe(0);
    });

    test("二次确认后快进合并并记副作用", async () => {
      const supervised = process.env.PISA_SUPERVISED;
      delete process.env.PISA_SUPERVISED;
      try {
        const id = await finishedTask();
        const res = await post(`/tickets/${id}/merge`, { confirm: true });
        const body = (await res.json()) as ActionResponse;
        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.restartRequired).toBe(true);
        expect(store.effectsOf(id).some((e) => e.kind === "merge")).toBe(true);
        expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).toBe(0);
      } finally {
        if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
      }
    });

    test("未成功的任务合并冲突", async () => {
      seedTask({ id: "t_queued_merge", status: "queued" });
      const res = await post("/tickets/t_queued_merge/merge", { confirm: true });
      expect(res.status).toBe(409);
      expect(store.effectsOf("t_queued_merge")).toHaveLength(0);
    });
  });

  describe("撤销", () => {
    test("默认只预览，不执行", async () => {
      seedTask({ id: "t_rewind", status: "cancelled" });
      const body = (await (await post("/tickets/t_rewind/rewind", {})).json()) as ActionResponse;
      expect(body.ok).toBe(true);
      expect(body.applied).toBe(false);
      expect(store.get("t_rewind")!.status).toBe("cancelled");
    });

    test("确认后标记 rewound", async () => {
      seedTask({ id: "t_rewind_yes", status: "cancelled" });
      const body = (await (await post("/tickets/t_rewind_yes/rewind", { confirm: true })).json()) as ActionResponse;
      expect(body.applied).toBe(true);
      expect(store.get("t_rewind_yes")!.status).toBe("rewound");
    });
  });
});
