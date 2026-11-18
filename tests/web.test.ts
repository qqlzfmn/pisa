import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    // 页面编辑的是磁盘上的配置文件：读写用例与其它用例共用这一份
    const configPath = join(stateDir, "pisa.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        trigger: "/pisa",
        retentionDays: 7,
        repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
        worker: { adapter: "omp", command: "noop", concurrency: 1, timeoutSec: 5 },
        schedules: [{ id: "nightly", cron: "0 3 * * *", prompt: "巡检" }],
      }),
    );
    cfg.configPath = configPath;
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

  function put(path: string, body?: unknown): Promise<Response> {
    return call(path, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
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

  describe("派活", () => {
    test("落库为排队任务并返回任务号", async () => {
      const res = await post("/api/tasks", { prompt: "修复登录跳转", confirm: true });
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
      const res = await post("/api/tasks", { prompt: "   ", confirm: true });
      expect(res.status).toBe(400);
      expect(store.recentTasks()).toHaveLength(0);
    });

    test("指定仓库", async () => {
      const res = await post("/api/tasks", { prompt: "换个仓库", repo: "demo", confirm: true });
      const body = (await res.json()) as DispatchResponse;
      expect(body.taskId).toBeTruthy();
      expect(store.get(body.taskId!)!.repo).toBe("demo");
    });

    test("单英文词不被误触防护拦下", async () => {
      const res = await post("/api/tasks", { prompt: "refactor", confirm: true });
      const body = (await res.json()) as DispatchResponse;
      expect(res.status).toBe(200);
      expect(body.taskId).toBeTruthy();
      expect(store.get(body.taskId!)!.status).toBe("queued");
    });
  });

  describe("取消", () => {
    test("排队任务直接取消", async () => {
      seedTask({ id: "t_cancel", status: "queued" });
      const res = await post("/api/tasks/t_cancel/cancel", { confirm: true });
      const body = (await res.json()) as ActionResponse;
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.status).toBe("cancelled");
      expect(store.get("t_cancel")!.status).toBe("cancelled");
    });

    test("他人任务也能取消（web 用 token 认证，不再校验原请求者）", async () => {
      seedTask({ id: "t_other_user", status: "queued", requester: "someone-else" });
      const res = await post("/api/tasks/t_other_user/cancel", { confirm: true });
      expect(res.status).toBe(200);
      expect(store.get("t_other_user")!.status).toBe("cancelled");
    });

    test("任务不存在返回冲突", async () => {
      const res = await post("/api/tasks/t_missing/cancel", { confirm: true });
      const body = (await res.json()) as ActionResponse;
      expect(res.status).toBe(409);
      expect(body.ok).toBe(false);
      expect(body.message).toContain("找不到任务");
    });
  });

  describe("合并", () => {
    async function finishedTask(): Promise<string> {
      const body = (await (await post("/api/tasks", { prompt: "新建 out.txt", confirm: true })).json()) as DispatchResponse;
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
    /** 真建一个工作副本并记账：撤销动作会真的删它 */
    function finishedWithWorktree(id: string): { workdir: string } {
      const workdir = join(stateDir, "wt", id);
      sh(["git", "-C", repo, "worktree", "add", "-q", workdir, "-b", `pisa/${id}`]);
      seedTask({ id, status: "succeeded", branch: `pisa/${id}`, endedAt: 2000 });
      store.effect(id, "worktree", workdir);
      return { workdir };
    }

    test("预览只列动作，不动磁盘", async () => {
      const { workdir } = finishedWithWorktree("t_rw_view");
      const res = await call("/api/tasks/t_rw_view/rewind", { headers: auth });
      const body = (await res.json()) as {
        ok: boolean;
        rewind: { merge: string; mergeLabel: string; actions: string[]; irreversible: string[] };
      };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.rewind.merge).toBe("none");
      expect(body.rewind.mergeLabel).toBe("未开 PR");
      expect(body.rewind.actions).toHaveLength(1);
      expect(body.rewind.actions[0]).toContain("工作副本");
      expect(existsSync(workdir)).toBe(true);
      expect(store.get("t_rw_view")!.status).toBe("succeeded");
      expect(store.effectsOf("t_rw_view")).toHaveLength(1);
    });

    test("缺少 confirm 不执行", async () => {
      const { workdir } = finishedWithWorktree("t_rw_unconfirmed");
      const res = await post("/api/tasks/t_rw_unconfirmed/rewind", {});
      expect(res.status).toBe(400);
      expect(existsSync(workdir)).toBe(true);
      expect(store.get("t_rw_unconfirmed")!.status).toBe("succeeded");
    });

    test("确认后执行、删副作用、置为已撤销并写审计", async () => {
      const { workdir } = finishedWithWorktree("t_rw_run");
      const res = await post("/api/tasks/t_rw_run/rewind", { confirm: true });
      const body = (await res.json()) as {
        ok: boolean;
        rewound: boolean;
        status: string;
        results: Array<{ ok: boolean }>;
        message: string;
      };
      expect(res.status).toBe(200);
      expect(body.rewound).toBe(true);
      expect(body.status).toBe("rewound");
      expect(body.results.every((r) => r.ok)).toBe(true);
      expect(existsSync(workdir)).toBe(false);
      expect(store.effectsOf("t_rw_run")).toHaveLength(0);
      expect(store.get("t_rw_run")!.status).toBe("rewound");

      const audit = (await (await call("/api/audit", { headers: auth })).json()) as {
        entries: Array<{ action: string; target: string; ok: boolean }>;
      };
      expect(audit.entries[0]).toMatchObject({ action: "task.rewind", target: "t_rw_run", ok: true });
    });

    test("运行中与不存在的任务拒绝预览", async () => {
      seedTask({ id: "t_rw_running", status: "running", startedAt: 1000 });
      expect((await call("/api/tasks/t_rw_running/rewind", { headers: auth })).status).toBe(409);
      expect((await call("/api/tasks/t_rw_missing/rewind", { headers: auth })).status).toBe(404);
    });
  });

  describe("指标", () => {
    test("按天聚合成功率、平均耗时与队列深度", async () => {
      const fixed = new Date(2026, 5, 15, 12, 0, 0).getTime();
      const scoped = createWebApp({ cfg, store, router, bus, token: TOKEN, now: () => fixed });
      const callScoped = (path: string) =>
        scoped(new Request(`http://127.0.0.1:8787${path}`, { headers: auth }));

      seedTask({ id: "m_ok", status: "queued", createdAt: fixed - 60_000 });
      store.transition("m_ok", "running", { startedAt: fixed - 55_000 });
      store.transition("m_ok", "succeeded", { endedAt: fixed - 50_000 });
      seedTask({ id: "m_bad", status: "queued", createdAt: fixed - 50_000 });
      store.transition("m_bad", "running", { startedAt: fixed - 45_000 });
      store.transition("m_bad", "failed", { endedAt: fixed - 40_000 });
      seedTask({ id: "m_wait", status: "queued", createdAt: fixed - 1000 });
      // 窗口外的旧任务不该出现在今天的桶里，也不该算进队列
      seedTask({ id: "m_old", status: "queued", createdAt: fixed - 3 * 86400_000 });
      store.transition("m_old", "running", { startedAt: fixed - 3 * 86400_000 + 1000 });
      store.transition("m_old", "succeeded", { endedAt: fixed - 3 * 86400_000 + 2000 });

      const res = await callScoped("/api/metrics?days=1");
      const body = (await res.json()) as {
        ok: boolean;
        metrics: Array<{
          date: string;
          total: number;
          succeeded: number;
          failed: number;
          successRate: number | null;
          avgDurationMs: number | null;
          queueDepth: number;
        }>;
      };
      expect(res.status).toBe(200);
      expect(body.metrics).toHaveLength(1);
      const day = body.metrics[0]!;
      expect(day.date).toBe("2026-06-15");
      expect(day.total).toBe(3);
      expect(day.succeeded).toBe(1);
      expect(day.failed).toBe(1);
      expect(day.successRate).toBe(0.5);
      expect(day.avgDurationMs).toBe(5000);
      expect(day.queueDepth).toBe(1);
    });
  });

  describe("配置编辑", () => {
    const configPath = () => join(stateDir, "pisa.config.json");
    const disk = () => JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, any>;

    const valid = () => ({
      repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
      worker: { adapter: "codex", command: "codex exec", concurrency: 3, timeoutSec: 900 },
      schedules: [{ id: "nightly", cron: "0 3 * * *", prompt: "巡检", enabled: false }],
    });

    test("读回文件里的可编辑字段", async () => {
      const res = await call("/api/config", { headers: auth });
      const body = (await res.json()) as {
        ok: boolean;
        path: string;
        config: {
          repos: Array<{ alias: string; path: string }>;
          worker: { concurrency: number };
          schedules: Array<{ id: string; enabled: boolean }>;
        };
      };
      expect(res.status).toBe(200);
      expect(body.path).toBe(configPath());
      expect(body.config.repos).toHaveLength(1);
      expect(body.config.repos[0]!.path).toBe(repo);
      expect(body.config.worker.concurrency).toBe(1);
      expect(body.config.schedules[0]).toMatchObject({ id: "nightly", enabled: true });
    });

    test("校验失败 400，文件不动，审计记失败", async () => {
      const before = readFileSync(configPath(), "utf8");
      const res = await put("/api/config", {
        confirm: true,
        config: {
          repos: [{ alias: "demo", path: repo }],
          worker: { adapter: "omp", command: "noop", concurrency: 0, timeoutSec: 5 },
          schedules: [{ id: "bad", cron: "0 3 * *", prompt: "巡检" }],
        },
      });
      const body = (await res.json()) as { ok: boolean; errors: string[] };
      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.errors.some((e) => e.includes("concurrency"))).toBe(true);
      expect(body.errors.some((e) => e.includes("cron"))).toBe(true);
      expect(readFileSync(configPath(), "utf8")).toBe(before);

      const audit = (await (await call("/api/audit", { headers: auth })).json()) as {
        entries: Array<{ action: string; ok: boolean }>;
      };
      expect(audit.entries[0]).toMatchObject({ action: "config.save", ok: false });
    });

    test("缺少 confirm 不落盘", async () => {
      const before = readFileSync(configPath(), "utf8");
      const res = await put("/api/config", { config: valid() });
      expect(res.status).toBe(400);
      expect(readFileSync(configPath(), "utf8")).toBe(before);
    });

    test("保存后写回文件、保留其它字段并提示重启", async () => {
      const res = await put("/api/config", {
        confirm: true,
        config: { ...valid(), repos: [{ ...valid().repos[0]!, alias: "demo" }, { alias: "lab", path: join(repo, "lab") }] },
      });
      const body = (await res.json()) as { ok: boolean; restartRequired: boolean; message: string; summary: string };
      expect(res.status).toBe(200);
      expect(body.restartRequired).toBe(true);
      expect(body.message).toContain("重启");

      const saved = disk();
      expect(saved.worker).toMatchObject({ adapter: "codex", command: "codex exec", concurrency: 3, timeoutSec: 900 });
      expect(saved.repos.map((r: { alias: string }) => r.alias)).toEqual(["demo", "lab"]);
      expect(saved.schedules).toEqual([{ id: "nightly", cron: "0 3 * * *", prompt: "巡检", enabled: false }]);
      // 表单之外的顶层字段原样保留
      expect(saved.retentionDays).toBe(7);
      expect(saved.trigger).toBe("/pisa");

      const reread = (await (await call("/api/config", { headers: auth })).json()) as {
        config: { worker: { concurrency: number }; repos: Array<{ alias: string }> };
      };
      expect(reread.config.worker.concurrency).toBe(3);
      expect(reread.config.repos.map((r) => r.alias)).toEqual(["demo", "lab"]);
    });
  });

  describe("审计", () => {
    test("派活写入审计并可按条数取回", async () => {
      await post("/api/tasks", { prompt: "写点什么", confirm: true });
      await post("/api/tasks", { prompt: "再来一条", confirm: true });
      const res = await call("/api/audit?limit=1", { headers: auth });
      const body = (await res.json()) as { ok: boolean; entries: Array<{ action: string; actor: string; ok: boolean }> };
      expect(res.status).toBe(200);
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]).toMatchObject({ action: "task.dispatch", actor: "u1", ok: true });
    });
  });
});
