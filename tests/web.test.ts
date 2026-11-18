import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEB, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { ReplyBus, createWebApp, type WebDeps } from "../src/web";
import { EXECUTOR_PAUSE_KEY } from "../src/status";
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
  executor: { paused: boolean; running: number; concurrency: number };
  counts: Record<string, number>;
  repos: string[];
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
  ticket: { id: string; status: string; repo: string };
  message: string;
  error?: string;
  reason?: string;
}

interface ActionResponse {
  ok: boolean;
  status: string | null;
  message: string;
  restartRequired?: boolean;
  undone?: boolean;
}

interface RetryResponse extends SubmitResponse {
  retriedFrom: string;
}

interface ListResponse {
  ok: boolean;
  tickets: Array<{ id: string; status: string; prompt: string }>;
  total: number;
}

describe("管理 API", () => {
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

    test("Bearer、专用头、cookie 三种凭证都放行", async () => {
      const variants: Array<Record<string, string>> = [auth, { "x-pisa-token": TOKEN }, { cookie: `pisa_web=${TOKEN}` }];
      for (const headers of variants) {
        const res = await call("/state", { headers });
        expect(res.status).toBe(200);
      }
    });

    test("API 不接受查询参数里的 token", async () => {
      for (const path of ["/state", "/tickets", "/tickets/t_x"]) {
        const res = await call(`${path}?token=${TOKEN}`);
        expect(res.status).toBe(401);
      }
    });

    test("/ui?token= 下发 cookie 并返回页面", async () => {
      const res = await call(`/ui?token=${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("set-cookie")).toContain(`pisa_web=${TOKEN}`);
      expect(res.headers.get("set-cookie")).toContain("HttpOnly");
      expect(await res.text()).toContain("pisa 控制台");
    });

    test("/ 跳转到 /ui 并保留 token", async () => {
      const res = await call(`/?token=${TOKEN}`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/ui?token=${TOKEN}`);
    });

    test("不支持的方法 405", async () => {
      const res = await call("/state", { method: "PUT", headers: auth });
      expect(res.status).toBe(405);
    });
  });

  describe("状态", () => {
    test("三组任务、计数、执行器与仓库筛选", async () => {
      seedTask({ id: "t_queue", status: "queued", prompt: "排队中" });
      seedTask({ id: "t_run", status: "running", startedAt: 1000, prompt: "跑着" });
      seedTask({ id: "t_ok", status: "succeeded", endedAt: 2000, prompt: "完成" });
      seedTask({ id: "t_other", status: "queued", repo: "other", prompt: "别的仓库" });
      store.beat();

      const res = await call("/state", { headers: auth });
      const body = (await res.json()) as StateResponse;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.repos).toEqual(["demo"]);
      expect(body.daemon.alive).toBe(true);
      expect(body.executor).toEqual({ paused: false, running: 1, concurrency: 1 });
      expect(body.counts.running).toBe(1);
      expect(body.counts.queued).toBe(2);
      expect(body.running.map((t) => t.id)).toEqual(["t_run"]);
      expect(body.running[0]!.statusLabel).toBe("运行中");
      expect(body.running[0]!.stage).toBe("working");
      expect(body.running[0]!.stageLabel).toBe("执行中");
      expect(body.queued.map((t) => t.id).sort()).toEqual(["t_other", "t_queue"]);
      expect(body.queued.every((t) => t.stage === "working/queued")).toBe(true);
      expect(body.finished.map((t) => t.id)).toEqual(["t_ok"]);
      expect(body.finished[0]!.stage).toBe("idle");

      const filtered = (await (await call("/state?repo=demo", { headers: auth })).json()) as StateResponse;
      expect(filtered.repo).toBe("demo");
      expect(filtered.queued.map((t) => t.id)).toEqual(["t_queue"]);
    });

    test("任务列表按状态过滤", async () => {
      seedTask({ id: "t_a", status: "failed", prompt: "失败了" });
      seedTask({ id: "t_b", status: "queued" });
      const body = (await (await call("/tickets?status=failed", { headers: auth })).json()) as ListResponse;
      expect(body.total).toBe(1);
      expect(body.tickets.map((t) => t.id)).toEqual(["t_a"]);
    });

    test("详情带 prompt、字段与日志尾部", async () => {
      const task = seedTask({ id: "t_detail", status: "queued", prompt: "看日志" });
      // insertTask 不写 started_at，时间戳只能经状态跃迁设置
      store.transition(task.id, "running", { startedAt: Date.now() - 5000 });
      mkdirSync(join(stateDir, "logs"), { recursive: true });
      writeFileSync(
        join(stateDir, "logs", `${task.id}.log`),
        [
          JSON.stringify({ ts: 1_700_000_000_000, stage: "worker", msg: "开始执行" }),
          JSON.stringify({ ts: 1_700_000_001_000, stage: "deliver", msg: "推送完成" }),
          "不是 JSON 的行",
        ].join("\n") + "\n",
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

      const logs = (await (await call(`/tickets/${task.id}/logs?tail=2`, { headers: auth })).json()) as {
        lines: string[];
      };
      expect(logs.lines).toHaveLength(2);
      expect(logs.lines[1]).toBe("不是 JSON 的行");

      const missing = await call("/tickets/t_missing", { headers: auth });
      expect(missing.status).toBe(404);
    });
  });

  describe("派活", () => {
    test("落库为排队任务并返回任务号", async () => {
      const res = await post("/tickets", { prompt: "修复登录跳转" });
      const body = (await res.json()) as SubmitResponse;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
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

    test("同一 eventId 重投只建一个任务", async () => {
      const first = (await (await post("/tickets", { prompt: "幂等", eventId: "ci:1" })).json()) as SubmitResponse;
      const second = (await (await post("/tickets", { prompt: "幂等", eventId: "ci:1" })).json()) as SubmitResponse;
      expect(second.ticketId).toBe(first.ticketId);
      expect(store.recentTasks()).toHaveLength(1);
    });

    test("空 prompt 400，不落库", async () => {
      const res = await post("/tickets", { prompt: "   " });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ActionResponse;
      expect(body.ok).toBe(false);
      expect(store.recentTasks()).toHaveLength(0);
    });

    test("未授权仓库按配置错误返回", async () => {
      const res = await post("/tickets", { prompt: "越权", repo: "other" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as SubmitResponse;
      expect(body.reason).toBe("config");
      expect(store.recentTasks()).toHaveLength(0);
    });

    test("单英文词不被误触防护拦下", async () => {
      const res = await post("/tickets", { prompt: "refactor" });
      const body = (await res.json()) as SubmitResponse;
      expect(res.status).toBe(200);
      expect(body.ticketId).toBeTruthy();
      expect(store.get(body.ticketId!)!.status).toBe("queued");
    });
  });

  describe("停止", () => {
    test("排队任务直接取消", async () => {
      seedTask({ id: "t_cancel", status: "queued" });
      const res = await post("/tickets/t_cancel/stop");
      const body = (await res.json()) as ActionResponse;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.status).toBe("cancelled");
      expect(store.get("t_cancel")!.status).toBe("cancelled");
    });

    test("他人任务也能停止（token 认证，不再校验原请求者）", async () => {
      seedTask({ id: "t_other_user", status: "queued", requester: "someone-else" });
      const res = await post("/tickets/t_other_user/stop");
      expect(res.status).toBe(200);
      expect(store.get("t_other_user")!.status).toBe("cancelled");
    });

    test("任务不存在 404", async () => {
      const res = await post("/tickets/t_missing/stop");
      const body = (await res.json()) as { ok: boolean; error: string; reason: string };
      expect(res.status).toBe(404);
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("not_found");
      expect(body.error).toContain("找不到任务");
    });

    test("终态任务冲突 409", async () => {
      seedTask({ id: "t_done", status: "succeeded" });
      const res = await post("/tickets/t_done/stop");
      expect(res.status).toBe(409);
      expect(store.get("t_done")!.status).toBe("succeeded");
    });
  });

  describe("重试", () => {
    test("失败任务在原分支上续跑", async () => {
      seedTask({ id: "t_failed", status: "failed", branch: "pisa/t_failed", prompt: "原需求" });
      const res = await post("/tickets/t_failed/retry");
      const body = (await res.json()) as RetryResponse;
      expect(res.status).toBe(200);
      expect(body.retriedFrom).toBe("t_failed");
      const child = store.get(body.ticketId!)!;
      expect(child.id).not.toBe("t_failed");
      expect(child.status).toBe("queued");
      expect(child.baseRef).toBe("pisa/t_failed");
      expect(child.prompt).toBe("原需求");
      // 原任务不可变
      expect(store.get("t_failed")!.status).toBe("failed");
    });

    test("没有分支的失败任务按原需求重投", async () => {
      seedTask({ id: "t_failed_nb", status: "failed", prompt: "没分支" });
      const res = await post("/tickets/t_failed_nb/retry");
      const body = (await res.json()) as RetryResponse;
      expect(res.status).toBe(200);
      const child = store.get(body.ticketId!)!;
      expect(child.baseRef).toBeNull();
      expect(child.prompt).toBe("没分支");
      expect(child.repo).toBe("demo");
    });

    test("只有失败或取消可以重试", async () => {
      seedTask({ id: "t_ok", status: "succeeded", branch: "pisa/t_ok" });
      const res = await post("/tickets/t_ok/retry");
      expect(res.status).toBe(409);
      const body = (await res.json()) as ActionResponse & { reason?: string };
      expect(body.reason).toBe("conflict");
    });
  });

  describe("执行器闸门", () => {
    test("暂停后不再领取任务，恢复后继续", async () => {
      const paused = await post("/executor/pause");
      expect(paused.status).toBe(200);
      expect(store.getMeta(EXECUTOR_PAUSE_KEY)).toBe("1");

      const state = (await (await call("/state", { headers: auth })).json()) as StateResponse;
      expect(state.executor.paused).toBe(true);

      seedTask({ id: "t_gated", status: "queued", branch: "pisa/t_gated" });
      expect(await router.drainOnce()).toBe(false);
      expect(store.get("t_gated")!.status).toBe("queued");

      const resumed = await post("/executor/pause", { paused: false });
      const resumedBody = (await resumed.json()) as { executor: { paused: boolean } };
      expect(resumedBody.executor.paused).toBe(false);
      expect(store.getMeta(EXECUTOR_PAUSE_KEY)).toBe("0");
      expect(await router.drainOnce()).toBe(true);
      expect(store.get("t_gated")!.status).toBe("succeeded");
    });

    test("paused 必须是布尔值", async () => {
      const res = await post("/executor/pause", { paused: "yes" });
      expect(res.status).toBe(400);
      expect(store.getMeta(EXECUTOR_PAUSE_KEY)).toBeNull();
    });
  });

  describe("合并", () => {
    async function finishedTicket(): Promise<string> {
      const body = (await (await post("/tickets", { prompt: "新建 out.txt" })).json()) as SubmitResponse;
      await router.drainOnce();
      return body.ticketId!;
    }

    test("缺少 confirm 时 400，且不动主干", async () => {
      const id = await finishedTicket();
      const res = await post(`/tickets/${id}/merge`, {});
      expect(res.status).toBe(400);
      expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).not.toBe(0);
    });

    test("二次确认后快进合并、记副作用并提示需要重启", async () => {
      const supervised = process.env.PISA_SUPERVISED;
      delete process.env.PISA_SUPERVISED;
      try {
        const id = await finishedTicket();
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

    test("未成功的任务合并失败", async () => {
      seedTask({ id: "t_queued_merge", status: "queued" });
      const res = await post("/tickets/t_queued_merge/merge", { confirm: true });
      expect(res.status).toBe(409);
      expect(store.effectsOf("t_queued_merge")).toHaveLength(0);
    });
  });

  describe("撤销", () => {
    test("不带 confirm 只返回预览，不改状态", async () => {
      seedTask({ id: "t_rewind", status: "succeeded" });
      const res = await post("/tickets/t_rewind/rewind");
      const body = (await res.json()) as ActionResponse;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.message.length).toBeGreaterThan(0);
      expect(store.get("t_rewind")!.status).toBe("succeeded");
    });

    test("确认后标记撤销", async () => {
      seedTask({ id: "t_rewind_yes", status: "succeeded" });
      const res = await post("/tickets/t_rewind_yes/rewind", { confirm: true });
      const body = (await res.json()) as ActionResponse;
      expect(res.status).toBe(200);
      expect(body.undone).toBe(true);
      expect(store.get("t_rewind_yes")!.status).toBe("rewound");
    });
  });
});
