import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import type { Config } from "../src/config";
import type { Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh } from "../src/git";
import { WebChannel, resolveWebToken, startWebServer, type TaskView, type WebServer } from "../src/web";
import type { LogLine } from "../src/log";

const TOKEN = "test-token";

interface BoardBody {
  counts: Record<string, number>;
  repos: string[];
  running: TaskView[];
  queued: TaskView[];
  finished: TaskView[];
}

interface DetailBody {
  task: TaskView;
  log: LogLine[];
}

interface DispatchBody {
  ok: boolean;
  task: TaskView;
  message: string;
}

interface ActionBody {
  ok: boolean;
  message: string;
  followUp: string;
  task: TaskView | null;
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-web-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function makeCfg(demo: string, extra: string, stateDir: string): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo", "extra"] },
    repos: [
      { alias: "demo", path: demo, baseBranch: "main" },
      { alias: "extra", path: extra, baseBranch: "main" },
    ],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir,
  };
}

const okWorker: WorkerRunner = {
  async run(_task, workdir): Promise<WorkerResult> {
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    return { ok: true, summary: "改了 out.txt", exitCode: 0 };
  },
};

function seedTask(store: Store, over: Partial<Task> & { id: string }): Task {
  const { id, ...rest } = over;
  const task: Task = {
    id,
    source: `seed:${id}`,
    channel: "fake",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "种子任务",
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

describe("Web 控制台", () => {
  let demo: string;
  let extra: string;
  let stateDir: string;
  let store: Store;
  let channel: WebChannel;
  let router: Router;
  let cfg: Config;
  let server: WebServer;

  beforeEach(() => {
    demo = makeRepo();
    extra = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-web-state-"));
    store = new Store(":memory:");
    channel = new WebChannel();
    cfg = makeCfg(demo, extra, stateDir);
    router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel });
    server = startWebServer({ cfg, store, router, channel, port: 0, token: TOKEN });
  });

  afterEach(() => {
    server.stop();
    store.close();
    rmSync(demo, { recursive: true, force: true });
    rmSync(extra, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function url(path: string, withToken = true): string {
    const sep = path.includes("?") ? "&" : "?";
    return `http://127.0.0.1:${server.port}${path}${withToken ? `${sep}token=${TOKEN}` : ""}`;
  }

  async function call<T>(path: string, init?: RequestInit, withToken = true): Promise<{ status: number; body: T }> {
    const res = await fetch(url(path, withToken), {
      ...init,
      headers: { "content-type": "application/json", "x-pisa-token": TOKEN, ...(init?.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  describe("鉴权", () => {
    test("缺 token 一律 401", async () => {
      const page = await fetch(`http://127.0.0.1:${server.port}/ui`);
      expect(page.status).toBe(401);
      const board = await fetch(`http://127.0.0.1:${server.port}/api/tasks`);
      expect(board.status).toBe(401);
      const dispatch = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
        method: "POST",
        body: JSON.stringify({ prompt: "不该建" }),
      });
      expect(dispatch.status).toBe(401);
      expect(store.recentTasks().length).toBe(0);
    });

    test("错误 token 401", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks?token=wrong`);
      expect(res.status).toBe(401);
    });

    test("两种头都能通过：x-pisa-token 与 Authorization: Bearer", async () => {
      const byHeader = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
        headers: { "x-pisa-token": TOKEN },
      });
      expect(byHeader.status).toBe(200);
      const byBearer = await fetch(`http://127.0.0.1:${server.port}/api/tasks`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(byBearer.status).toBe(200);
    });

    test("/ui 返回单页并把 token 注入脚本", async () => {
      const res = await fetch(url("/ui"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain(`const TOKEN = "${TOKEN}"`);
      expect(html).toContain("pisa 控制台");
      expect(html).not.toContain("__PISA_TOKEN__");
      expect(html).not.toContain("<script src=");
    });
  });

  describe("看板", () => {
    test("按状态分组、带耗时与仓库清单", async () => {
      seedTask(store, { id: "t_run", repo: "demo", createdAt: Date.now() - 40_000, prompt: "跑着的" });
      store.claimQueued("t_run", Date.now() - 30_000, "pisa/t_run");
      seedTask(store, { id: "t_wait", repo: "demo", createdAt: 30, prompt: "排队的" });
      seedTask(store, { id: "t_ok", repo: "demo", createdAt: 40, prompt: "成功的" });
      expect(store.claimQueued("t_ok", 45_000, "pisa/t_ok")).toBe(true);
      expect(store.transition("t_ok", "succeeded", { endedAt: 50_000 })).toBe(true);
      seedTask(store, { id: "t_bad", repo: "demo", createdAt: 50, prompt: "失败的" });
      expect(store.claimQueued("t_bad", 55_000, "pisa/t_bad")).toBe(true);
      expect(store.transition("t_bad", "failed", { endedAt: 56_000 })).toBe(true);
      seedTask(store, { id: "t_other", repo: "extra", createdAt: 60, prompt: "别的仓库" });

      const { status, body } = await call<BoardBody>("/api/tasks");
      expect(status).toBe(200);
      expect(body.repos).toEqual(["demo", "extra"]);
      expect(body.counts.running).toBe(1);
      expect(body.counts.queued).toBe(2);
      expect(body.counts.succeeded).toBe(1);
      expect(body.counts.failed).toBe(1);
      expect(body.running.map((t) => t.id)).toEqual(["t_run"]);
      expect(body.queued.map((t) => t.id)).toEqual(["t_wait", "t_other"]);
      expect(body.finished.map((t) => t.id)).toEqual(["t_bad", "t_ok"]);
      expect(body.running[0]!.duration).toMatch(/^\d+s$/);
      expect(body.finished[1]!.duration).toBe("5s");
      expect(body.queued[0]!.duration).toBe("");
    });

    test("仓库筛选只返回该仓库", async () => {
      seedTask(store, { id: "t_demo", repo: "demo", createdAt: 10 });
      seedTask(store, { id: "t_extra", repo: "extra", createdAt: 20 });

      const { body } = await call<BoardBody>("/api/tasks?repo=extra");
      expect(body.counts.queued).toBe(1);
      expect(body.queued.map((t) => t.id)).toEqual(["t_extra"]);
      expect(body.running).toEqual([]);
      expect(body.finished).toEqual([]);
    });
  });

  describe("详情", () => {
    test("返回任务全字段与结构化日志尾部", async () => {
      seedTask(store, { id: "t_log", prompt: "看日志", branch: "pisa/t_log" });
      mkdirSync(join(stateDir, "logs"), { recursive: true });
      writeFileSync(
        join(stateDir, "logs", "t_log.log"),
        [
          JSON.stringify({ ts: "2026-11-18T00:00:00.000Z", stage: "worker", msg: "开始" }),
          JSON.stringify({ ts: "2026-11-18T00:00:01.000Z", stage: "deliver", msg: "提交 1 个文件" }),
          "裸行",
        ].join("\n"),
      );

      const { status, body } = await call<DetailBody>("/api/tasks/t_log");
      expect(status).toBe(200);
      expect(body.task.prompt).toBe("看日志");
      expect(body.task.branch).toBe("pisa/t_log");
      expect(body.log.map((l) => l.stage)).toEqual(["worker", "deliver", "raw"]);
      expect(body.log[2]!.msg).toBe("裸行");
    });

    test("没有日志文件时日志为空", async () => {
      seedTask(store, { id: "t_nolog" });
      const { body } = await call<DetailBody>("/api/tasks/t_nolog");
      expect(body.log).toEqual([]);
    });

    test("未知任务 404", async () => {
      const { status } = await call<{ error: string }>("/api/tasks/t_missing");
      expect(status).toBe(404);
    });
  });

  describe("派活", () => {
    test("建任务并走同一条排队链路", async () => {
      const { status, body } = await call<DispatchBody>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ prompt: "加一条校验", repo: "extra" }),
      });
      expect(status).toBe(201);
      expect(body.task.status).toBe("queued");
      expect(body.task.repo).toBe("extra");
      expect(body.task.prompt).toBe("加一条校验");
      expect(body.task.requester).toBe("u1");
      expect(body.message).toContain("已接单");
      expect(store.get(body.task.id)?.repo).toBe("extra");

      // 与 IM 派活共用调度：drain 后真的执行
      await router.drainOnce();
      expect(store.get(body.task.id)?.status).toBe("succeeded");
      expect(store.get(body.task.id)?.summary).toContain("out.txt");
    });

    test("空需求、未知仓库、命令词都被拒绝且不建任务", async () => {
      const empty = await call<{ error: string }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ prompt: "   " }),
      });
      expect(empty.status).toBe(400);
      expect(empty.body.error).toContain("需求不能为空");

      const unknownRepo = await call<{ error: string }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ prompt: "做点事", repo: "nope" }),
      });
      expect(unknownRepo.status).toBe(400);
      expect(unknownRepo.body.error).toContain("未知仓库");

      const commandWord = await call<{ error: string }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ prompt: "status" }),
      });
      expect(commandWord.status).toBe(400);

      const singleWord = await call<{ error: string }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({ prompt: "refactor" }),
      });
      expect(singleWord.status).toBe(400);
      expect(singleWord.body.error).toContain("英文单词");

      expect(store.recentTasks().length).toBe(0);
    });

    test("坏 JSON 400", async () => {
      const res = await fetch(url("/api/tasks"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-pisa-token": TOKEN },
        body: "{",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("取消", () => {
    test("排队任务立即取消", async () => {
      seedTask(store, { id: "t_cancel" });
      const { status, body } = await call<ActionBody>("/api/tasks/t_cancel/cancel", { method: "POST", body: "{}" });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.task?.status).toBe("cancelled");
      expect(store.get("t_cancel")?.status).toBe("cancelled");
    });

    test("运行中任务标记取消请求", async () => {
      seedTask(store, { id: "t_busy" });
      store.claimQueued("t_busy", 10, "pisa/t_busy");
      const { status, body } = await call<ActionBody>("/api/tasks/t_busy/cancel", { method: "POST", body: "{}" });
      expect(status).toBe(200);
      expect(body.message).toContain("取消中");
      expect(store.isCancelRequested("t_busy")).toBe(true);
    });

    test("已结束任务 409，未知任务 404", async () => {
      seedTask(store, { id: "t_done" });
      expect(store.claimQueued("t_done", 1, "pisa/t_done")).toBe(true);
      expect(store.transition("t_done", "succeeded", { endedAt: 2 })).toBe(true);
      const done = await call<ActionBody>("/api/tasks/t_done/cancel", { method: "POST", body: "{}" });
      expect(done.status).toBe(409);
      expect(done.body.ok).toBe(false);

      const missing = await call<{ error: string }>("/api/tasks/t_none/cancel", { method: "POST", body: "{}" });
      expect(missing.status).toBe(404);
    });

    test("控制台可以取消别人的任务", async () => {
      seedTask(store, { id: "t_other_user", requester: "someone-else" });
      const { status } = await call<ActionBody>("/api/tasks/t_other_user/cancel", { method: "POST", body: "{}" });
      expect(status).toBe(200);
      expect(store.get("t_other_user")?.status).toBe("cancelled");
    });
  });

  describe("合并", () => {
    test("合并成功任务后主干出现改动", async () => {
      const supervised = process.env.PISA_SUPERVISED;
      delete process.env.PISA_SUPERVISED;
      try {
        const created = await call<DispatchBody>("/api/tasks", {
          method: "POST",
          body: JSON.stringify({ prompt: "新建 out.txt" }),
        });
        expect(created.status).toBe(201);
        await router.drainOnce();
        const id = created.body.task.id;
        expect(store.get(id)?.status).toBe("succeeded");

        const { status, body } = await call<ActionBody>(`/api/tasks/${id}/merge`, { method: "POST", body: "{}" });
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.message).toContain("已合并");
        expect(body.followUp).toContain("重启");
        expect(sh(["git", "-C", demo, "cat-file", "-e", "main:out.txt"]).code).toBe(0);
      } finally {
        if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
      }
    });

    test("未成功的任务 409", async () => {
      seedTask(store, { id: "t_wait" });
      const { status, body } = await call<ActionBody>("/api/tasks/t_wait/merge", { method: "POST", body: "{}" });
      expect(status).toBe(409);
      expect(body.message).toContain("没有可合并的分支");
    });

    test("合并别人的任务走管理入口", async () => {
      const supervised = process.env.PISA_SUPERVISED;
      delete process.env.PISA_SUPERVISED;
      try {
        const created = await call<DispatchBody>("/api/tasks", {
          method: "POST",
          body: JSON.stringify({ prompt: "别人的任务" }),
        });
        await router.drainOnce();
        const id = created.body.task.id;
        // 直接把请求者改成别人，确认 admin 不依赖请求者
        expect(store.get(id)?.requester).toBe("u1");
        const { status } = await call<ActionBody>(`/api/tasks/${id}/merge`, { method: "POST", body: "{}" });
        expect(status).toBe(200);
      } finally {
        if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
      }
    });

    test("未知任务 404", async () => {
      const { status } = await call<{ error: string }>("/api/tasks/t_none/merge", { method: "POST", body: "{}" });
      expect(status).toBe(404);
    });
  });

  describe("路由兜底", () => {
    test("未知路径 404，错误方法 405", async () => {
      expect((await call<{ error: string }>("/api/unknown")).status).toBe(404);
      expect((await call<{ error: string }>("/api/tasks/t_x", { method: "POST", body: "{}" })).status).toBe(405);
      expect((await call<{ error: string }>("/api/tasks/t_x/cancel", { method: "GET" })).status).toBe(404);
    });
  });
});

describe("WebChannel", () => {
  test("网页回执不投递给 IM，取走后清空", async () => {
    const inner = {
      name: "fake",
      sent: [] as string[],
      async start() {},
      async send(_chatId: string, text: string) {
        this.sent.push(text);
      },
      async stop() {},
    };
    const channel = new WebChannel(inner);
    await channel.send("web:abc", "只给网页");
    expect(inner.sent).toEqual([]);
    expect(channel.take("web:abc")).toBe("只给网页");
    expect(channel.take("web:abc")).toBeUndefined();

    await channel.send("c1", "给 IM");
    expect(inner.sent).toEqual(["给 IM"]);
  });

  test("回执最多保留 64 条", async () => {
    const channel = new WebChannel();
    for (let i = 0; i < 70; i += 1) await channel.send(`web:${i}`, `m${i}`);
    expect(channel.take("web:0")).toBeUndefined();
    expect(channel.take("web:69")).toBe("m69");
  });
});

describe("resolveWebToken", () => {
  test("环境变量优先", () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-web-token-"));
    try {
      const cfg = makeCfg(dir, dir, dir);
      process.env.PISA_WEB_TOKEN = "from-env";
      expect(resolveWebToken(cfg)).toBe("from-env");
    } finally {
      delete process.env.PISA_WEB_TOKEN;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("没有环境变量时生成并落盘，重启后复用", () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-web-token-"));
    try {
      delete process.env.PISA_WEB_TOKEN;
      const cfg = makeCfg(dir, dir, dir);
      const token = resolveWebToken(cfg);
      expect(token).toMatch(/^[0-9a-f]{48}$/);
      expect(resolveWebToken(cfg)).toBe(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
