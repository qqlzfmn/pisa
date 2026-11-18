import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEB, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { createWebApp, type WebDeps } from "../src/web";
import { ReplyBus } from "../src/channels/reply-bus";
import { API_CHAT_ID } from "../src/api";
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

function makeCfg(repoPath: string, stateDir: string, enabled: boolean): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: false,
    whitelist: { users: [], repos: ["demo"] },
    repos: [{ alias: "demo", path: repoPath, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    web: { ...DEFAULT_WEB, enabled, userId: "u1", chatId: "web" },
    stateDir,
  };
}

const TOKEN = "abc123";

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

describe("web 外壳", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let down: FakeChannel;
  let cfg: Config;
  let router: Router;
  let app: (req: Request) => Promise<Response>;

  function build(enabled: boolean): void {
    cfg = makeCfg(repo, stateDir, enabled);
    const bus = new ReplyBus("web", down, [API_CHAT_ID]);
    router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
    app = createWebApp({ cfg, store, router, bus, token: TOKEN } satisfies WebDeps);
  }

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-web-state-"));
    store = new Store(":memory:");
    down = new FakeChannel();
    build(true);
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  const auth = { authorization: `Bearer ${TOKEN}` };

  function call(path: string, init: RequestInit = {}): Promise<Response> {
    return app(new Request(`http://127.0.0.1:8787${path}`, init));
  }

  function seedTask(over: Partial<Task> & { id: string }): void {
    const { id, ...rest } = over;
    store.insertTask({
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
    });
  }

  describe("鉴权", () => {
    test("无凭证 401", async () => {
      for (const [path, method] of [
        ["/ui", "GET"],
        ["/api/state", "GET"],
        ["/api/tasks", "POST"],
      ] as const) {
        const res = await call(path, { method, body: method === "POST" ? "{}" : undefined });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
      }
    });

    test("错误 token 401", async () => {
      const res = await call("/ui", { headers: { authorization: "Bearer wrong" } });
      expect(res.status).toBe(401);
    });

    test("Bearer、专用头、cookie 三种凭证都放行", async () => {
      const variants: Array<Record<string, string>> = [auth, { "x-pisa-token": TOKEN }, { cookie: `pisa_web=${TOKEN}` }];
      for (const headers of variants) {
        expect((await call("/ui", { headers })).status).toBe(200);
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
      const res = await call("/api/state", { method: "PUT", headers: auth });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    });

    test("未知路径 404", async () => {
      const res = await call("/nope", { headers: auth });
      expect(res.status).toBe(404);
    });
  });

  describe("页面开关", () => {
    test("web.enabled=false 时接口仍可用，页面关闭", async () => {
      build(false);
      const state = await call("/api/state", { headers: auth });
      expect(state.status).toBe(200);
      const ui = await call("/ui", { headers: auth });
      expect(ui.status).toBe(404);
      expect(((await ui.json()) as { reason: string }).reason).toBe("config");
      expect((await call("/", { headers: auth })).status).toBe(404);
    });
  });

  describe("健康检查", () => {
    /** seedTask 不写时间戳：这里直接把起止时间落库，构造 24h 窗口内的样本 */
    function seedFinished(id: string, status: "succeeded" | "failed", startedAt: number, endedAt: number): void {
      seedTask({ id, status, createdAt: startedAt });
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
      const res = await call("/health");
      const body = (await res.json()) as HealthResponse;
      expect(body.ok).toBe(false);
      expect(body.daemon.ageMs).toBeNull();
      expect(res.status).toBe(503);
    });

    test("只接受 GET", async () => {
      const res = await call("/health", { method: "POST", body: "{}" });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    });
  });
});
