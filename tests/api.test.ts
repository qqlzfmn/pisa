import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEB, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { createWebApp, type WebDeps } from "../src/web";
import { ReplyBus } from "../src/channels/reply-bus";
import { API_CHANNEL, API_CHAT_ID } from "../src/api";
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
  const dir = mkdtempSync(join(tmpdir(), "pisa-api-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function makeCfg(repoPath: string, stateDir: string): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: false,
    whitelist: { users: [], repos: ["demo"] },
    repos: [{ alias: "demo", path: repoPath, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    web: { ...DEFAULT_WEB, enabled: false, userId: "u1", chatId: "web" },
    stateDir,
  };
}

const TOKEN = "abc123";
const auth = { authorization: `Bearer ${TOKEN}` };

describe("管理接口", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let down: FakeChannel;
  let cfg: Config;
  let router: Router;
  let app: (req: Request) => Promise<Response>;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-api-state-"));
    store = new Store(":memory:");
    down = new FakeChannel();
    cfg = makeCfg(repo, stateDir);
    // 管理接口把回执投到 api 会话，总线要把它也当本机缓冲
    const bus = new ReplyBus("web", down, [API_CHAT_ID]);
    router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
    app = createWebApp({ cfg, store, router, bus, token: TOKEN } satisfies WebDeps);
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

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
    test("无凭证与错误 token 都是 401 且带 reason", async () => {
      for (const path of ["/api/state", "/api/tasks", "/api/board"]) {
        const res = await call(path);
        expect(res.status).toBe(401);
        expect(((await res.json()) as { reason: string }).reason).toBe("auth");
      }
      const wrong = await call("/api/state", { headers: { authorization: "Bearer wrong" } });
      expect(wrong.status).toBe(401);
    });

    test("/api 不接受 query token，只认请求头与 cookie", async () => {
      const query = await call(`/api/state?token=${TOKEN}`);
      expect(query.status).toBe(401);
      const header = await call(`/api/state?token=${TOKEN}`, { headers: auth });
      expect(header.status).toBe(200);
      const cookie = await call("/api/state", { headers: { cookie: `pisa_web=${TOKEN}` } });
      expect(cookie.status).toBe(200);
    });
  });

  describe("状态", () => {
    test("/api/state 汇总守护进程、执行器、队列与仓库", async () => {
      seedTask({ id: "t_queue", status: "queued", prompt: "排队中" });
      seedTask({ id: "t_run", status: "running", startedAt: Date.now() - 3000, prompt: "跑着" });
      store.beat();

      const res = await call("/api/state", { headers: auth });
      const body = (await res.json()) as {
        ok: boolean;
        daemon: { alive: boolean };
        executor: { paused: boolean; running: number; limit: number };
        counts: Record<string, number>;
        queued: Array<{ id: string }>;
        running: Array<{ id: string; status: string }>;
        repos: Array<{ alias: string; path: string; remote: string | null; baseBranch: string | null; allowed: boolean }>;
        text: string;
      };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.daemon.alive).toBe(true);
      expect(body.executor).toEqual({ paused: false, running: 1, limit: 1 });
      expect(body.counts.queued).toBe(1);
      expect(body.running.map((t) => t.id)).toEqual(["t_run"]);
      expect(body.running[0]!.status).toBe("running");
      expect(body.queued.map((t) => t.id)).toEqual(["t_queue"]);
      expect(body.repos).toEqual([{ alias: "demo", path: repo, remote: null, baseBranch: "main", allowed: true }]);
      expect(body.text).toContain("运行中");
    });

    test("执行器暂停后 state.ok 为 false", async () => {
      store.beat();
      const res = await post("/api/executor/pause", { paused: true });
      const body = (await res.json()) as { executor: { paused: boolean } };
      expect(res.status).toBe(200);
      expect(body.executor.paused).toBe(true);
      expect(router.isPaused()).toBe(true);

      const state = (await (await call("/api/state", { headers: auth })).json()) as { ok: boolean; text: string };
      expect(state.ok).toBe(false);
      expect(state.text).toContain("执行器已暂停");

      expect(((await (await post("/api/executor/pause", { paused: false })).json()) as { executor: { paused: boolean } }).executor.paused).toBe(false);
      expect(router.isPaused()).toBe(false);
    });

    test("paused 必须是布尔值", async () => {
      const res = await post("/api/executor/pause", { paused: "yes" });
      expect(res.status).toBe(400);
    });

    test("暂停时不再领取排队任务", async () => {
      seedTask({ id: "t_wait", status: "queued" });
      router.pause();
      await router.drainOnce();
      expect(store.get("t_wait")!.status).toBe("queued");
      router.resume();
      await router.drainOnce();
      expect(store.get("t_wait")!.status).toBe("succeeded");
    });
  });

  describe("任务", () => {
    test("未知状态筛选直接 400", async () => {
      const res = await call("/api/tasks?status=bogus", { headers: auth });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("未知状态");
    });

    test("详情带需求、阶段与日志尾部", async () => {
      const task = seedTask({ id: "t_detail", status: "queued", prompt: "看日志" });
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
      const body = (await res.json()) as {
        task: { prompt: string; stageLabel: string; duration: number | null };
        logTail: string[];
      };
      expect(res.status).toBe(200);
      expect(body.task.prompt).toBe("看日志");
      expect(body.task.stageLabel).toBe("执行中");
      expect(body.logTail).toHaveLength(3);
      expect(body.logTail[0]).toMatch(/^\d{2}:\d{2}:\d{2} worker 开始执行$/);
      expect(body.logTail[2]).toBe("不是 JSON 的行");

      const missing = await call("/api/tasks/t_missing", { headers: auth });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { reason: string }).reason).toBe("not_found");
    });

    test("日志接口支持 tail", async () => {
      seedTask({ id: "t_logs", status: "queued" });
      mkdirSync(join(stateDir, "logs"), { recursive: true });
      const lines = [1, 2, 3].map((i) => JSON.stringify({ ts: i, stage: "worker", msg: `第 ${i} 行` }));
      writeFileSync(join(stateDir, "logs", "t_logs.log"), `${lines.join("\n")}\n`);

      const body = (await (await call("/api/tasks/t_logs/logs?tail=2", { headers: auth })).json()) as { lines: string[] };
      expect(body.lines).toHaveLength(2);
      expect(body.lines[1]).toContain("第 3 行");
    });

    test("过滤列表", async () => {
      seedTask({ id: "t_queue", status: "queued", prompt: "排队中" });
      seedTask({ id: "t_other", status: "queued", repo: "other", prompt: "别的仓库" });
      const all = (await (await call("/api/tasks", { headers: auth })).json()) as { tasks: Array<{ id: string }> };
      expect(all.tasks).toHaveLength(2);
      const demo = (await (await call("/api/tasks?repo=demo&status=queued", { headers: auth })).json()) as {
        tasks: Array<{ id: string }>;
      };
      expect(demo.tasks.map((t) => t.id)).toEqual(["t_queue"]);
    });

    test("看板分组带中文状态", async () => {
      seedTask({ id: "t_queue", status: "queued" });
      seedTask({ id: "t_ok", status: "succeeded", endedAt: 2000 });
      store.beat();
      const body = (await (await call("/api/board", { headers: auth })).json()) as {
        repos: string[];
        queued: Array<{ id: string; statusLabel: string; stageLabel: string }>;
        finished: Array<{ id: string; statusLabel: string }>;
      };
      expect(body.repos).toEqual(["demo"]);
      expect(body.queued[0]!.statusLabel).toBe("排队");
      expect(body.finished[0]!.statusLabel).toBe("成功");
    });

    test("投递任务：channel=api，回执不漏给真实通道", async () => {
      const res = await post("/api/tasks", { prompt: "修复登录跳转" });
      const body = (await res.json()) as { taskId: string };
      expect(res.status).toBe(200);
      const task = store.get(body.taskId)!;
      expect(task.status).toBe("queued");
      expect(task.channel).toBe(API_CHANNEL);
      expect(task.repo).toBe("demo");
      expect(down.sent).toHaveLength(0);
    });

    test("同 eventId 不重复建任务", async () => {
      const first = (await (await post("/api/tasks", { prompt: "修 x", eventId: "evt-1" })).json()) as { taskId: string };
      const second = (await (await post("/api/tasks", { prompt: "修 x", eventId: "evt-1" })).json()) as { taskId: string };
      expect(second.taskId).toBe(first.taskId);
      expect(store.listTasks({})).toHaveLength(1);
    });

    test("空正文与未知仓库", async () => {
      expect((await post("/api/tasks", { prompt: "  " })).status).toBe(400);
      const unknown = await post("/api/tasks", { prompt: "随便", repo: "nope" });
      const body = (await unknown.json()) as { reason: string; error: string };
      expect(unknown.status).toBe(409);
      expect(body.reason).toBe("config");
      expect(store.recentTasks()).toHaveLength(0);
    });

    test("仓库不在白名单时拒绝投递", async () => {
      cfg.repos.push({ alias: "other", path: repo, baseBranch: "main" });
      const res = await post("/api/tasks", { prompt: "偷偷改", repo: "other" });
      const body = (await res.json()) as { reason: string; error: string };
      expect(res.status).toBe(409);
      expect(body.reason).toBe("config");
      expect(body.error).toContain("白名单");
      expect(store.listTasks({})).toHaveLength(0);
    });
  });

  describe("动作", () => {
    test("取消排队任务", async () => {
      seedTask({ id: "t_cancel", status: "queued" });
      const res = await post("/api/tasks/t_cancel/cancel");
      const body = (await res.json()) as { ok: boolean; status: string };
      expect(res.status).toBe(200);
      expect(body.status).toBe("cancelled");
      expect(store.get("t_cancel")!.status).toBe("cancelled");
    });

    test("取消已结束任务是状态错误", async () => {
      seedTask({ id: "t_done", status: "succeeded", endedAt: 1 });
      const res = await post("/api/tasks/t_done/cancel");
      expect(res.status).toBe(409);
      expect(((await res.json()) as { reason: string }).reason).toBe("state");
    });

    test("恢复遇到缺失的工作副本时如实拒绝", async () => {
      const task = seedTask({ id: "t_paused", status: "queued" });
      store.transition(task.id, "running");
      store.transition(task.id, "paused");
      const res = await post("/api/tasks/t_paused/resume");
      const body = (await res.json()) as { reason: string; error: string };
      expect(res.status).toBe(409);
      expect(body.reason).toBe("state");
      expect(body.error).toContain("工作副本");
    });

    test("恢复非中断任务是状态错误", async () => {
      seedTask({ id: "t_running", status: "queued" });
      const res = await post("/api/tasks/t_running/resume");
      expect(res.status).toBe(409);
    });

    test("重试失败任务生成新任务", async () => {
      const original = seedTask({ id: "t_failed", status: "queued", prompt: "修登录", baseRef: "main" });
      store.transition(original.id, "running");
      store.transition(original.id, "failed", { error: "adapter 挂了" });
      const res = await post("/api/tasks/t_failed/retry");
      const body = (await res.json()) as { taskId: string };
      expect(res.status).toBe(200);
      expect(body.taskId).not.toBe("t_failed");
      const copy = store.get(body.taskId)!;
      expect(copy.prompt).toBe("修登录");
      expect(copy.baseRef).toBe("main");
      expect(copy.context).toContain("重试自任务 t_failed");
    });

    test("重试有 PR 的任务沿用同一分支与 PR", async () => {
      const original = seedTask({ id: "t_pr", status: "queued", prompt: "改样式" });
      store.transition(original.id, "running");
      store.transition(original.id, "failed", { branch: "pisa/t_pr", prUrl: "https://example.com/pull/7", error: "测试挂了" });
      const body = (await (await post("/api/tasks/t_pr/retry")).json()) as { taskId: string };
      const copy = store.get(body.taskId)!;
      expect(copy.branch).toBe("pisa/t_pr");
      expect(copy.prUrl).toBe("https://example.com/pull/7");
    });

    test("重试未失败的任务被拒绝", async () => {
      seedTask({ id: "t_queued", status: "queued" });
      const res = await post("/api/tasks/t_queued/retry");
      expect(res.status).toBe(409);
      expect(store.listTasks({})).toHaveLength(1);
    });

    test("续跑需要新的要求", async () => {
      seedTask({ id: "t_branch", status: "succeeded", branch: "pisa/t_branch", endedAt: 1 });
      const res = await post("/api/tasks/t_branch/continue", {});
      expect(res.status).toBe(400);
      const ok = await post("/api/tasks/t_branch/continue", { prompt: "再改一下" });
      const body = (await ok.json()) as { taskId: string };
      expect(ok.status).toBe(200);
      expect(store.get(body.taskId)!.baseRef).toBe("pisa/t_branch");
    });

    test("撤销：不带 yes 只出计划，不改状态", async () => {
      const task = seedTask({ id: "t_rewind", status: "queued" });
      store.transition(task.id, "running");
      store.transition(task.id, "succeeded", { branch: "pisa/t_rewind", endedAt: 1 });
      const preview = await post("/api/tasks/t_rewind/rewind", {});
      const body = (await preview.json()) as { ok: boolean; message: string };
      expect(preview.status).toBe(200);
      expect(body.message).toContain("t_rewind");
      expect(store.get("t_rewind")!.status).toBe("succeeded");
    });

    test("撤销未结束的任务被拒绝", async () => {
      seedTask({ id: "t_live", status: "queued" });
      const res = await post("/api/tasks/t_live/rewind", { yes: true });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { reason: string }).reason).toBe("state");
    });

    test("合并：缺 confirm 400，未成功任务 409", async () => {
      seedTask({ id: "t_queued_merge", status: "queued" });
      expect((await post("/api/tasks/t_queued_merge/merge", {})).status).toBe(400);
      const res = await post("/api/tasks/t_queued_merge/merge", { confirm: true });
      expect(res.status).toBe(409);
      expect(store.effectsOf("t_queued_merge")).toHaveLength(0);
    });

    test("合并快进主干并记副作用", async () => {
      const dispatched = (await (await post("/api/tasks", { prompt: "新建 out.txt" })).json()) as { taskId: string };
      await router.drainOnce();
      const supervised = process.env.PISA_SUPERVISED;
      delete process.env.PISA_SUPERVISED;
      try {
        const res = await post(`/api/tasks/${dispatched.taskId}/merge`, { confirm: true });
        expect(res.status).toBe(200);
        expect(store.effectsOf(dispatched.taskId).some((e) => e.kind === "merge")).toBe(true);
        expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).toBe(0);
      } finally {
        if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
      }
    });
  });
});
