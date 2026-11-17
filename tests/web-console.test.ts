import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { DEFAULT_CONFIG, mergeConfig, type Config } from "../src/config";
import { createWebApp, type WebDeps } from "../src/web/server";
import type { RewindProbes } from "../src/rewind";
import type { Task } from "../src/types";

const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();

const dirs: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { app: (req: Request) => Promise<Response>; cfg: Config; store: Store; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pisa-web-console-"));
  dirs.push(dir);
  const configPath = join(dir, "pisa.config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        trigger: "/pisa",
        repos: [{ alias: "demo", path: join(dir, "demo"), baseBranch: "main" }],
        worker: { adapter: "omp", command: "omp", timeoutSec: 3600, extraArgs: [], concurrency: 2 },
        scheduler: { chatId: "c1", userId: "u1" },
        schedules: [],
        delivery: { push: false, pr: false },
      },
      null,
      2,
    ),
  );
  const cfg = mergeConfig(DEFAULT_CONFIG, {
    trigger: "/pisa",
    repos: [{ alias: "demo", path: join(dir, "demo"), baseBranch: "main" }],
    scheduler: { chatId: "c1", userId: "u1" },
    stateDir: join(dir, "state"),
  });
  const store = new Store(join(dir, "state", "pisa.db"));
  stores.push(store);
  const probes: RewindProbes = {
    branchExists: () => false,
    worktreeExists: () => false,
    prState: () => ({ state: "OPEN", mergeCommit: null }),
  };
  const deps: WebDeps = {
    cfg,
    store,
    configPath,
    probes,
    now: () => NOW,
    runner: () => ({ code: 0, out: "", err: "" }),
  };
  return { app: createWebApp(deps), cfg, store, configPath };
}

function seed(store: Store, over: Partial<Task> & { id: string }): Task {
  const { id, ...rest } = over;
  const task: Task = {
    id,
    source: `seed:${id}`,
    channel: "cli",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "做点事",
    status: "succeeded",
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
    createdAt: NOW - 60_000,
    startedAt: NOW - 60_000,
    endedAt: NOW - 30_000,
    cancelRequested: false,
    ...rest,
  };
  store.insertTask(task);
  return task;
}

function post(app: (req: Request) => Promise<Response>, path: string, body: unknown): Promise<Response> {
  return app(
    new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function get(app: (req: Request) => Promise<Response>, path: string): Promise<Response> {
  return app(new Request(`http://127.0.0.1${path}`));
}

describe("页面与状态", () => {
  test("GET / 渲染图表、配置表单与撤销入口", async () => {
    const { app, store } = fixture();
    seed(store, { id: "t_done" });
    const res = await get(app, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const marker of ["pisa 控制台", 'id="config"', 'id="rewind"', "成功率", "平均耗时", "队列深度", "t_done", "审计"]) {
      expect(html).toContain(marker);
    }
    expect(html.match(/<svg/g)?.length).toBe(3);
    expect(html).toContain('data-id="t_done"');
  });

  test("GET /api/state 给出计数、指标与可编辑配置", async () => {
    const { app, store } = fixture();
    seed(store, { id: "t_ok" });
    seed(store, { id: "t_bad", status: "failed" });
    const body = (await (await get(app, "/api/state")).json()) as {
      ok: boolean;
      state: {
        totals: { total: number; succeeded: number; failed: number };
        tasks: Array<{ id: string; canRewind: boolean }>;
        daily: unknown[];
        queue: unknown[];
        config: { repos: Array<{ alias: string }> };
        configIssues: string[];
      };
    };
    expect(body.ok).toBe(true);
    expect(body.state.totals.total).toBe(2);
    expect(body.state.totals.succeeded).toBe(1);
    expect(body.state.totals.failed).toBe(1);
    expect(body.state.daily).toHaveLength(7);
    expect(body.state.queue).toHaveLength(24);
    expect(body.state.config.repos.map((r) => r.alias)).toEqual(["demo"]);
    expect(body.state.configIssues).toEqual([]);
    expect(body.state.tasks.every((t) => t.canRewind)).toBe(true);
  });

  test("跨天完成的任务计入完成日指标", async () => {
    const { app, store } = fixture();
    const DAY = 86_400_000;
    seed(store, { id: "t_span", status: "queued", startedAt: null, endedAt: null, createdAt: NOW - 9 * DAY });
    expect(store.transition("t_span", "running", { startedAt: NOW - 2 * 3_600_000 })).toBe(true);
    expect(store.transition("t_span", "succeeded", { endedAt: NOW - 3_600_000 })).toBe(true);

    const body = (await (await get(app, "/api/state")).json()) as {
      state: { daily: Array<{ succeeded: number; avgDurationMs: number | null }> };
    };
    const today = body.state.daily[body.state.daily.length - 1]!;
    expect(today.succeeded).toBe(1);
    expect(today.avgDurationMs).toBe(3_600_000);
  });

  test("非 GET/POST 与未知路径被拒绝", async () => {
    const { app } = fixture();
    const put = await app(new Request("http://127.0.0.1/api/config", { method: "PUT" }));
    expect(put.status).toBe(405);
    const missing = await post(app, "/api/unknown", {});
    expect(missing.status).toBe(404);
  });
});

describe("配置校验与保存", () => {
  test("dryRun 校验失败返回 422 且不动文件", async () => {
    const { app, configPath } = fixture();
    const before = readFileSync(configPath, "utf8");
    const res = await post(app, "/api/config", { dryRun: true, patch: { worker: { concurrency: 0 } } });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: string[] };
    expect(body.errors).toContain("worker.concurrency 必须是 1–64 的整数");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("未知配置段被拒绝", async () => {
    const { app, configPath } = fixture();
    const before = readFileSync(configPath, "utf8");
    const res = await post(app, "/api/config", { patch: { trigger: "/other" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: string[] };
    expect(body.errors).toEqual(["不支持的配置段：trigger"]);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("校验通过但缺令牌返回 428，令牌无效返回 409 并记审计", async () => {
    const { app, store, configPath } = fixture();
    const patch = { worker: { concurrency: 4 } };
    const preview = (await (await post(app, "/api/config", { dryRun: true, patch })).json()) as {
      ok: boolean;
      token: string;
      requiresRestart: boolean;
    };
    expect(preview.ok).toBe(true);
    expect(preview.requiresRestart).toBe(true);

    const noToken = await post(app, "/api/config", { patch });
    expect(noToken.status).toBe(428);

    const wrong = await post(app, "/api/config", { patch, token: "deadbeef" });
    expect(wrong.status).toBe(409);
    expect(store.auditLog(1)[0]).toMatchObject({ action: "config.save", ok: false });
    expect(JSON.parse(readFileSync(configPath, "utf8")).worker.concurrency).toBe(2);
  });

  test("带令牌保存只改补丁涉及的键并保留其余配置", async () => {
    const { app, store, configPath } = fixture();
    const patch = {
      worker: { concurrency: 4 },
      schedules: [{ id: "nightly", cron: "0 3 * * *", prompt: "升级依赖", repo: "demo", enabled: true }],
    };
    const preview = (await (await post(app, "/api/config", { dryRun: true, patch })).json()) as { token: string };
    const saved = await post(app, "/api/config", { patch, token: preview.token });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { ok: boolean; changed: string[]; requiresRestart: boolean };
    expect(body.ok).toBe(true);
    expect(body.changed).toEqual(["worker", "schedules"]);
    expect(body.requiresRestart).toBe(true);

    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      trigger: string;
      worker: { adapter: string; command: string; concurrency: number };
      schedules: Array<{ id: string; repo: string }>;
      delivery: unknown;
    };
    expect(written.worker).toMatchObject({ adapter: "omp", command: "omp", concurrency: 4 });
    expect(written.schedules).toHaveLength(1);
    expect(written.schedules[0]).toMatchObject({ id: "nightly", repo: "demo" });
    expect(written.trigger).toBe("/pisa");
    expect(written.delivery).toEqual({ push: false, pr: false });

    expect(store.auditLog(1)[0]).toMatchObject({ action: "config.save", ok: true });
  });

  test("令牌只能消费一次", async () => {
    const { app } = fixture();
    const patch = { worker: { concurrency: 3 } };
    const preview = (await (await post(app, "/api/config", { dryRun: true, patch })).json()) as { token: string };
    expect((await post(app, "/api/config", { patch, token: preview.token })).status).toBe(200);
    expect((await post(app, "/api/config", { patch, token: preview.token })).status).toBe(409);
  });

  test("预览后改动补丁导致令牌失效", async () => {
    const { app } = fixture();
    const preview = (await (await post(app, "/api/config", { dryRun: true, patch: { worker: { concurrency: 3 } } })).json()) as {
      token: string;
    };
    const res = await post(app, "/api/config", { patch: { worker: { concurrency: 5 } }, token: preview.token });
    expect(res.status).toBe(409);
  });
});

describe("rewind 预览与执行", () => {
  test("预览给出计划与令牌，执行后标记 rewound 并记审计", async () => {
    const { app, store } = fixture();
    seed(store, { id: "t_done" });

    const preview = await post(app, "/api/rewind/preview", { taskId: "t_done" });
    expect(preview.status).toBe(200);
    const plan = (await preview.json()) as { ok: boolean; actions: string[]; text: string; token: string; merge: string };
    expect(plan.ok).toBe(true);
    expect(plan.actions).toEqual([]);
    expect(plan.merge).toBe("none");
    expect(plan.text).toContain("没有可撤销的副作用");
    expect(plan.token).toHaveLength(32);

    const bogus = await post(app, "/api/rewind/apply", { taskId: "t_done", token: "nope" });
    expect(bogus.status).toBe(409);
    expect(store.get("t_done")!.status).toBe("succeeded");
    expect(store.auditLog(1)[0]).toMatchObject({ action: "rewind", target: "t_done", ok: false });

    const applied = await post(app, "/api/rewind/apply", { taskId: "t_done", token: plan.token });
    expect(applied.status).toBe(200);
    const appliedBody = (await applied.json()) as { ok: boolean };
    expect(appliedBody.ok).toBe(true);
    expect(store.get("t_done")!.status).toBe("rewound");
    expect(store.auditLog(1)[0]).toMatchObject({ action: "rewind", target: "t_done", ok: true });

    expect((await post(app, "/api/rewind/apply", { taskId: "t_done", token: plan.token })).status).toBe(409);
    const again = await post(app, "/api/rewind/preview", { taskId: "t_done" });
    expect(again.status).toBe(409);
    const againBody = (await again.json()) as { error: string };
    expect(againBody.error).toContain("已撤销");
  });

  test("未结束任务与不存在的任务被拒绝", async () => {
    const { app, store } = fixture();
    seed(store, { id: "t_run", status: "queued", startedAt: null, endedAt: null });
    const running = await post(app, "/api/rewind/preview", { taskId: "t_run" });
    expect(running.status).toBe(409);
    const runningBody = (await running.json()) as { error: string };
    expect(runningBody.error).toContain("先等它结束");
    expect((await post(app, "/api/rewind/preview", { taskId: "t_missing" })).status).toBe(404);
    expect((await post(app, "/api/rewind/preview", {})).status).toBe(400);
  });
});
