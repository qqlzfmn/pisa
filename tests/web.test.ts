import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

interface BoardResponse {
  ok: boolean;
  daemon: { alive: boolean; ageMs: number | null };
  counts: Record<string, number>;
  repos: string[];
  repo: string | null;
  running: Array<{ id: string; prompt: string; statusLabel: string; stage: string; stageLabel: string }>;
  queued: Array<{ id: string; prompt: string; stage: string }>;
  finished: Array<{ id: string; statusLabel: string; stage: string }>;
}

interface HealthResponse {
  ok: boolean;
  uptimeSec: number;
  queue: number;
  running: number;
  last24h: {
    finished: number;
    succeeded: number;
    failed: number;
    successRate: number | null;
    durationSamples: number;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  repos: Array<{ repo: string; running: number; queued: number; finished24h: number }>;
  daemon: { alive: boolean; ageMs: number | null };
}

interface DetailResponse {
  ok: boolean;
  task: { id: string; prompt: string; duration: string; branch: string | null; stage: string; stageLabel: string };
  effects: Array<{ kind: string; target: string }>;
  logTail: string[];
}

interface DispatchResponse {
  ok: boolean;
  taskId: string | null;
  message: string;
  error?: string;
}

interface ActionResponse {
  ok: boolean;
  status: string | null;
  message: string;
}

describe("web 控制台", () => {
  let repo: string;
  let stateDir: string;
  let cfgPath: string;
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
    cfgPath = join(stateDir, "pisa.config.json");
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
    const deps: WebDeps = { cfg, store, router, bus, token: TOKEN, configPath: cfgPath };
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
        ["/api/tasks", "GET"],
        ["/api/tasks", "POST"],
      ] as const) {
        const res = await call(path, { method, body: method === "POST" ? "{}" : undefined });
        expect(res.status).toBe(401);
      }
      expect(store.recentTasks()).toHaveLength(0);
    });

    test("错误 token 401", async () => {
      const res = await call("/api/tasks", { headers: { authorization: "Bearer wrong" } });
      expect(res.status).toBe(401);
    });

    test("Bearer、专用头、cookie 三种凭证都放行", async () => {
      const variants: Array<Record<string, string>> = [auth, { "x-pisa-token": TOKEN }, { cookie: `pisa_web=${TOKEN}` }];
      for (const headers of variants) {
        const res = await call("/api/tasks", { headers });
        expect(res.status).toBe(200);
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
      const res = await call("/api/tasks", { method: "PUT", headers: auth });
      expect(res.status).toBe(405);
    });
  });

  describe("看板", () => {
    test("三组任务、计数与仓库筛选", async () => {
      seedTask({ id: "t_queue", status: "queued", prompt: "排队中" });
      seedTask({ id: "t_run", status: "running", startedAt: 1000, prompt: "跑着" });
      seedTask({ id: "t_ok", status: "succeeded", endedAt: 2000, prompt: "完成" });
      seedTask({ id: "t_other", status: "queued", repo: "other", prompt: "别的仓库" });
      store.beat();

      const res = await call("/api/tasks", { headers: auth });
      const body = (await res.json()) as BoardResponse;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.repos).toEqual(["demo"]);
      expect(body.daemon.alive).toBe(true);
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

      const filtered = (await (await call("/api/tasks?repo=demo", { headers: auth })).json()) as BoardResponse;
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
        [
          JSON.stringify({ ts: 1_700_000_000_000, stage: "worker", msg: "开始执行" }),
          JSON.stringify({ ts: 1_700_000_001_000, stage: "deliver", msg: "推送完成" }),
          "不是 JSON 的行",
        ].join("\n") + "\n",
      );

      const res = await call(`/api/tasks/${task.id}`, { headers: auth });
      const body = (await res.json()) as DetailResponse;
      expect(res.status).toBe(200);
      expect(body.task.prompt).toBe("看日志");
      expect(body.task.stage).toBe("working");
      expect(body.task.stageLabel).toBe("执行中");
      expect(body.task.duration).toMatch(/^\d+s$/);
      expect(body.logTail).toHaveLength(3);
      expect(body.logTail[0]).toMatch(/^\d{2}:\d{2}:\d{2} worker 开始执行$/);
      expect(body.logTail[1]).toContain("deliver 推送完成");
      expect(body.logTail[2]).toBe("不是 JSON 的行");

      const missing = await call("/api/tasks/t_missing", { headers: auth });
      expect(missing.status).toBe(404);
    });
  });

  describe("健康检查", () => {
    /** insertTask 不写时间戳：这里直接把结束时间落库，构造 24h 窗口内的样本 */
    function seedFinished(id: string, status: "succeeded" | "failed", startedAt: number, endedAt: number): void {
      seedTask({ id, status, repo: "demo", createdAt: startedAt });
      store.db.query("UPDATE tasks SET started_at = ?, ended_at = ? WHERE id = ?").run(startedAt, endedAt, id);
    }

    test("无需 token 即可读取健康快照", async () => {
      const now = Date.now();
      seedTask({ id: "t_queue", status: "queued" });
      seedTask({ id: "t_run", status: "running", startedAt: now - 10_000 });
      seedFinished("t_ok", "succeeded", now - 60_000, now - 30_000);
      seedFinished("t_bad", "failed", now - 45_000, now - 35_000);
      seedTask({ id: "t_other", status: "running", repo: "other", startedAt: now - 5_000 });
      store.beat();

      const res = await call("/health");
      const body = (await res.json()) as HealthResponse;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
      expect(body.queue).toBe(1);
      expect(body.running).toBe(2);
      expect(body.daemon.alive).toBe(true);
      expect(body.last24h.finished).toBe(2);
      expect(body.last24h.succeeded).toBe(1);
      expect(body.last24h.failed).toBe(1);
      expect(body.last24h.successRate).toBe(0.5);
      expect(body.last24h.durationSamples).toBe(2);
      // 耗时 30s 与 10s：最近邻分位 p50 取第 1 个，p95 取第 2 个
      expect(body.last24h.p50Ms).toBe(10_000);
      expect(body.last24h.p95Ms).toBe(30_000);
      expect(body.repos).toEqual([
        { repo: "demo", running: 1, queued: 1, finished24h: 2 },
        { repo: "other", running: 1, queued: 0, finished24h: 0 },
      ]);
    });

    test("配置内没有任务的仓库也出现在视图里", async () => {
      store.beat();
      const body = (await (await call("/health")).json()) as HealthResponse;
      expect(body.repos).toEqual([{ repo: "demo", running: 0, queued: 0, finished24h: 0 }]);
      expect(body.last24h.finished).toBe(0);
      expect(body.last24h.successRate).toBeNull();
      expect(body.last24h.p50Ms).toBeNull();
    });

    test("心跳过期时 ok 为 false 且返回 503", async () => {
      const body = (await (await call("/health")).json()) as HealthResponse;
      expect(body.ok).toBe(false);
      expect(body.daemon.ageMs).toBeNull();
      expect((await call("/health")).status).toBe(503);
    });

    test("只接受 GET", async () => {
      const res = await call("/health", { method: "POST", body: "{}" });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    });
  });

  describe("派活", () => {
    test("落库为排队任务并返回任务号", async () => {
      const res = await post("/api/tasks", { prompt: "修复登录跳转" });
      const body = (await res.json()) as DispatchResponse;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.taskId).toBeTruthy();

      const task = store.get(body.taskId!)!;
      expect(task.status).toBe("queued");
      expect(task.prompt).toBe("修复登录跳转");
      expect(task.requester).toBe("u1");
      expect(task.channel).toBe("web");
      expect(task.repo).toBe("demo");
      // 回执被总线收走，没有漏到真实通道
      expect(down.sent).toHaveLength(0);
    });

    test("空 prompt 400，不落库", async () => {
      const res = await post("/api/tasks", { prompt: "   " });
      expect(res.status).toBe(400);
      expect(store.recentTasks()).toHaveLength(0);
    });

    test("指定仓库", async () => {
      const res = await post("/api/tasks", { prompt: "换个仓库", repo: "demo" });
      const body = (await res.json()) as DispatchResponse;
      expect(body.taskId).toBeTruthy();
      expect(store.get(body.taskId!)!.repo).toBe("demo");
    });

    test("单英文词不被误触防护拦下", async () => {
      const res = await post("/api/tasks", { prompt: "refactor" });
      const body = (await res.json()) as DispatchResponse;
      expect(res.status).toBe(200);
      expect(body.taskId).toBeTruthy();
      expect(store.get(body.taskId!)!.status).toBe("queued");
    });
  });

  describe("取消", () => {
    test("排队任务直接取消", async () => {
      seedTask({ id: "t_cancel", status: "queued" });
      const res = await post("/api/tasks/t_cancel/cancel");
      const body = (await res.json()) as ActionResponse;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.status).toBe("cancelled");
      expect(store.get("t_cancel")!.status).toBe("cancelled");
    });

    test("他人任务也能取消（web 用 token 认证，不再校验原请求者）", async () => {
      seedTask({ id: "t_other_user", status: "queued", requester: "someone-else" });
      const res = await post("/api/tasks/t_other_user/cancel");
      expect(res.status).toBe(200);
      expect(store.get("t_other_user")!.status).toBe("cancelled");
    });

    test("任务不存在返回冲突", async () => {
      const res = await post("/api/tasks/t_missing/cancel");
      const body = (await res.json()) as ActionResponse;
      expect(res.status).toBe(409);
      expect(body.ok).toBe(false);
      expect(body.message).toContain("找不到任务");
    });
  });

  describe("合并", () => {
    async function finishedTask(): Promise<string> {
      const body = (await (await post("/api/tasks", { prompt: "新建 out.txt" })).json()) as DispatchResponse;
      await router.drainOnce();
      return body.taskId!;
    }

    test("缺少 confirm 时 400，且不动主干", async () => {
      const id = await finishedTask();
      const res = await post(`/api/tasks/${id}/merge`, {});
      expect(res.status).toBe(400);
      expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).not.toBe(0);
    });

    test("二次确认后快进合并并记副作用", async () => {
      const supervised = process.env.PISA_SUPERVISED;
      delete process.env.PISA_SUPERVISED;
      try {
        const id = await finishedTask();
        const res = await post(`/api/tasks/${id}/merge`, { confirm: true });
        const body = (await res.json()) as ActionResponse;
        expect(res.status).toBe(200);
        expect(body.ok).toBe(true);
        expect(store.effectsOf(id).some((e) => e.kind === "merge")).toBe(true);
        expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).toBe(0);
      } finally {
        if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
      }
    });

    test("未成功的任务合并失败", async () => {
      seedTask({ id: "t_queued_merge", status: "queued" });
      const res = await post("/api/tasks/t_queued_merge/merge", { confirm: true });
      expect(res.status).toBe(409);
      expect(store.effectsOf("t_queued_merge")).toHaveLength(0);
    });
  });

  describe("撤销", () => {
    interface PlanBody {
      ok: boolean;
      plan: { taskId: string; merge: string; actions: Array<{ kind: string; label: string }>; notes: string[] };
    }

    /** 已成功、本地分支还在的任务：撤销动作可预测为删本地分支 */
    function finishedWithBranch(): string {
      const id = "t_rewind";
      store.insertTask({
        id,
        source: `seed:${id}`,
        channel: "fake",
        chatId: "web",
        requester: "u1",
        repo: "demo",
        prompt: "既有任务",
        status: "succeeded",
        branch: "pisa/t_rewind",
        prUrl: null,
        sessionId: null,
        baseRef: "main",
        context: null,
        replyPr: null,
        replyIssue: null,
        replyRepo: null,
        summary: null,
        error: null,
        createdAt: Date.now() - 3000,
        startedAt: Date.now() - 2000,
        endedAt: Date.now() - 1000,
        cancelRequested: false,
      });
      sh(["git", "-C", repo, "branch", "pisa/t_rewind"]);
      store.effect(id, "branch", "pisa/t_rewind", "本地分支");
      return id;
    }

    test("预览列出动作但不改仓库", async () => {
      const id = finishedWithBranch();
      const res = await call(`/api/tasks/${id}/rewind`, { headers: auth });
      const body = (await res.json()) as PlanBody;
      expect(res.status).toBe(200);
      expect(body.plan.merge).toBe("none");
      expect(body.plan.actions.map((a) => a.kind)).toEqual(["delete-local-branch"]);
      expect(body.plan.actions[0]!.label).toBe("删除本地分支 pisa/t_rewind");
      expect(sh(["git", "-C", repo, "rev-parse", "--verify", "pisa/t_rewind"]).code).toBe(0);
    });

    test("缺少 confirm 时 400，分支仍在", async () => {
      const id = finishedWithBranch();
      const res = await post(`/api/tasks/${id}/rewind`, {});
      expect(res.status).toBe(400);
      expect(sh(["git", "-C", repo, "rev-parse", "--verify", "pisa/t_rewind"]).code).toBe(0);
      expect(store.get(id)!.status).toBe("succeeded");
    });

    test("二次确认后执行并落 rewound、记审计", async () => {
      const id = finishedWithBranch();
      const res = await post(`/api/tasks/${id}/rewind`, { confirm: true });
      const body = (await res.json()) as ActionResponse;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.status).toBe("rewound");
      expect(sh(["git", "-C", repo, "rev-parse", "--verify", "pisa/t_rewind"]).code).not.toBe(0);
      expect(store.effectsOf(id)).toHaveLength(0);
      expect(store.recentAudit(5)[0]).toMatchObject({ action: "rewind", target: id, actor: "u1" });
    });

    test("未结束的任务拒绝撤销", async () => {
      seedTask({ id: "t_running_rewind", status: "running" });
      const res = await call("/api/tasks/t_running_rewind/rewind", { headers: auth });
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(res.status).toBe(409);
      expect(body.error).toContain("还没结束");
    });

    test("找不到任务时 404", async () => {
      const res = await call("/api/tasks/t_missing/rewind", { headers: auth });
      expect(res.status).toBe(404);
    });
  });

  describe("趋势", () => {
    interface MetricsBody {
      ok: boolean;
      hours: number;
      buckets: number;
      totals: { finished: number; succeeded: number };
      series: Array<{ finished: number; successRate: number | null; p50Ms: number | null; queueMax: number | null }>;
    }

    function finished(id: string, at: number, ok: boolean): void {
      seedTask({ id, status: ok ? "succeeded" : "failed", createdAt: at - 1000, startedAt: at - 900, endedAt: at });
    }

    test("按桶返回完成数、成功率与队列深度", async () => {
      const at = Date.now();
      finished("t_m1", at - 60_000, true);
      finished("t_m2", at - 120_000, false);
      store.sampleQueue({ at: at - 30_000, queued: 2, running: 1 });
      store.sampleQueue({ at: at - 90_000, queued: 0, running: 0 });

      const res = await call("/api/metrics?hours=1&buckets=6", { headers: auth });
      const body = (await res.json()) as MetricsBody;
      expect(res.status).toBe(200);
      expect(body.hours).toBe(1);
      expect(body.buckets).toBe(6);
      expect(body.series).toHaveLength(6);
      expect(body.series.reduce((n, b) => n + b.finished, 0)).toBe(2);
      expect(body.totals).toMatchObject({ finished: 2, succeeded: 1 });
      expect(body.series.some((b) => b.queueMax === 2)).toBe(true);
      expect(body.series.filter((b) => b.finished > 0).every((b) => b.successRate !== null)).toBe(true);
    });

    test("非法参数回落到默认窗口", async () => {
      const res = await call("/api/metrics?hours=0&buckets=1", { headers: auth });
      const body = (await res.json()) as MetricsBody;
      expect(body.hours).toBe(24);
      expect(body.buckets).toBe(24);
      expect(body.series).toHaveLength(24);
    });
  });

  describe("配置", () => {
    interface ConfigBody {
      ok: boolean;
      path: string;
      active: { worker: { concurrency: number } };
      draft: { worker: { concurrency: number }; repos: Array<{ alias: string }> };
      pendingRestart: boolean;
      errors: string[];
    }

    function readFileConfig(): Record<string, unknown> {
      return JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    }

    test("读取配置：草稿等于文件值，无待生效改动", async () => {
      const res = await call("/api/config", { headers: auth });
      const body = (await res.json()) as ConfigBody;
      expect(res.status).toBe(200);
      expect(body.path).toBe(cfgPath);
      expect(body.draft.repos.map((r) => r.alias)).toEqual(["demo"]);
      expect(body.draft.worker.concurrency).toBe(1);
      expect(body.pendingRestart).toBe(false);
      expect(body.errors).toEqual([]);
    });

    test("缺少 confirm 时 400，文件不变", async () => {
      const res = await post("/api/config", { draft: (await (await call("/api/config", { headers: auth })).json() as ConfigBody).draft });
      expect(res.status).toBe(400);
      expect(readFileConfig().worker).toMatchObject({ concurrency: 1 });
    });

    test("校验失败时 400、列全部错误并记审计", async () => {
      const draft = (await (await call("/api/config", { headers: auth })).json() as ConfigBody).draft;
      draft.worker.concurrency = 0;
      const res = await post("/api/config", { confirm: true, draft });
      const body = (await res.json()) as { ok: boolean; errors: string[] };
      expect(res.status).toBe(400);
      expect(body.errors).toEqual(["worker.concurrency 必须是 1–32 的整数"]);
      expect(readFileConfig().worker).toMatchObject({ concurrency: 1 });
      expect(store.recentAudit(5)[0]).toMatchObject({ action: "config", target: cfgPath });
    });

    test("保存后文件更新、其它键保留、提示重启并记审计", async () => {
      const before = readFileConfig();
      const draft = (await (await call("/api/config", { headers: auth })).json() as ConfigBody).draft;
      draft.worker.concurrency = 3;
      const res = await post("/api/config", { confirm: true, draft });
      const body = (await res.json()) as { ok: boolean; restartRequired: boolean; message: string };
      expect(res.status).toBe(200);
      expect(body.restartRequired).toBe(true);
      expect(body.message).toContain("重启");
      const after = readFileConfig();
      expect(after.worker).toMatchObject({ concurrency: 3, extraArgs: [] });
      expect(after.trigger).toBe(before.trigger);
      expect(after.whitelist).toEqual(before.whitelist);
      expect(store.recentAudit(5)[0]).toMatchObject({ action: "config", actor: "u1" });

      // 进程仍持有旧配置，页面据此提示「重启后生效」
      const view = (await (await call("/api/config", { headers: auth })).json()) as ConfigBody;
      expect(view.active.worker.concurrency).toBe(1);
      expect(view.pendingRestart).toBe(true);
    });
  });

  describe("审计", () => {
    test("派活与取消都落一条记录", async () => {
      const dispatch = (await (await post("/api/tasks", { prompt: "写 out.txt" })).json()) as DispatchResponse;
      const entries = (await (await call("/api/audit", { headers: auth })).json()) as {
        entries: Array<{ action: string; target: string; actor: string }>;
      };
      expect(entries.entries[0]).toMatchObject({ action: "dispatch", target: dispatch.taskId, actor: "u1" });

      await post(`/api/tasks/${dispatch.taskId}/cancel`, {});
      const after = (await (await call("/api/audit?limit=5", { headers: auth })).json()) as {
        entries: Array<{ action: string; target: string }>;
      };
      expect(after.entries[0]).toMatchObject({ action: "cancel", target: dispatch.taskId });
    });

    test("limit 越界回落到默认 50", async () => {
      const res = await call("/api/audit?limit=9999", { headers: auth });
      const body = (await res.json()) as { ok: boolean; entries: unknown[] };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.entries).toHaveLength(0);
    });
  });
});
