import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { createMgmtHandler } from "../src/mgmt";
import { GitDeliverer } from "../src/deliver";
import type { Config } from "../src/config";
import type { ChannelAdapter, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh } from "../src/git";
import { TaskLogger } from "../src/log";

const TOKEN = "test-token";

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: Array<{ chatId: string; text: string }> = [];
  async start(): Promise<void> {}
  async send(chatId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ chatId, text });
    return { messageId: String(this.sent.length) };
  }
  async stop(): Promise<void> {}
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-mgmt-repo-"));
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
    stateDir,
  };
}

const okWorker: WorkerRunner = {
  async run(_task, workdir): Promise<WorkerResult> {
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    return { ok: true, summary: "改了 out.txt", exitCode: 0 };
  },
};

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("等待超时");
}

describe("管理接口", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let router: Router;
  let handle: (req: Request) => Promise<Response>;

  const call = (path: string, init: RequestInit = {}, host = "127.0.0.1:8800") =>
    handle(new Request(`http://${host}${path}`, { ...init, headers: { "x-pisa-token": TOKEN, ...(init.headers ?? {}) } }));

  function seedTask(over: Partial<Task> & { id: string }): Task {
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

  function createBranch(name: string, file: string, content: string): void {
    sh(["git", "-C", repo, "checkout", "-qb", name]);
    writeFileSync(join(repo, file), content);
    sh(["git", "-C", repo, "add", "-A"]);
    sh(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", name]);
    sh(["git", "-C", repo, "checkout", "-q", "main"]);
  }

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-mgmt-state-"));
    store = new Store(join(stateDir, "pisa.db"));
    const cfg = makeCfg(repo, stateDir);
    router = new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel: new FakeChannel(),
    });
    handle = createMgmtHandler({ cfg, store, router, token: TOKEN });
  });

  afterEach(async () => {
    await router.stop(100);
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  describe("鉴权", () => {
    test("非回环来源一律 403", async () => {
      const res = await call("/state", {}, "10.1.2.3:8800");
      expect(res.status).toBe(403);
    });

    test("缺 token 或 token 错误 403，且不返回任务字段", async () => {
      const missing = await handle(new Request("http://127.0.0.1:8800/state"));
      expect(missing.status).toBe(403);
      const denied = (await missing.json()) as Record<string, unknown>;
      expect(Object.keys(denied)).toEqual(["error"]);

      const wrong = await handle(
        new Request("http://127.0.0.1:8800/state", { headers: { "x-pisa-token": "nope" } }),
      );
      expect(wrong.status).toBe(403);
      expect(await wrong.text()).not.toContain("counts");
    });

    test("only-header 鉴权：query 参数不放行", async () => {
      const res = await handle(new Request(`http://127.0.0.1:8800/state?token=${TOKEN}`));
      expect(res.status).toBe(403);
    });
  });

  test("GET /state 返回快照", async () => {
    seedTask({ id: "t_queue", status: "queued" });
    const res = await call("/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paused: boolean; counts: { queued: number }; queued: Array<{ id: string }> };
    expect(body.paused).toBe(false);
    expect(body.counts.queued).toBe(1);
    expect(body.queued.map((t) => t.id)).toEqual(["t_queue"]);
  });

  test("POST /tickets 建单；缺少 prompt 为 400", async () => {
    const created = await call("/tickets", { method: "POST", body: JSON.stringify({ prompt: "修登录" }) });
    expect(created.status).toBe(201);
    const { ticket } = (await created.json()) as { ticket: Task };
    expect(ticket.status).toBe("queued");
    expect(ticket.repo).toBe("demo");
    expect(store.get(ticket.id)?.prompt).toBe("修登录");

    const bad = await call("/tickets", { method: "POST", body: JSON.stringify({ prompt: "  " }) });
    expect(bad.status).toBe(400);
  });

  test("GET /tickets/:id 区分存在与不存在", async () => {
    seedTask({ id: "t_a", status: "succeeded" });
    store.effect("t_a", "branch", "pisa/t_a", "分支");

    const found = await call("/tickets/t_a");
    expect(found.status).toBe(200);
    const body = (await found.json()) as { ticket: Task; effects: Array<{ kind: string }> };
    expect(body.ticket.id).toBe("t_a");
    expect(body.effects.map((e) => e.kind)).toEqual(["branch"]);

    expect((await call("/tickets/t_none")).status).toBe(404);
  });

  test("retry：失败可重试，成功不可", async () => {
    seedTask({ id: "t_fail", status: "failed", error: "boom", endedAt: 1 });
    const ok = await call("/tickets/t_fail/retry", { method: "POST" });
    expect(ok.status).toBe(200);
    expect(store.get("t_fail")?.status).toBe("queued");
    expect(store.get("t_fail")?.error).toBeNull();

    seedTask({ id: "t_ok", status: "succeeded" });
    expect((await call("/tickets/t_ok/retry", { method: "POST" })).status).toBe(409);
    expect((await call("/tickets/t_none/retry", { method: "POST" })).status).toBe(404);
  });

  test("stop：排队的立刻取消，运行中的标记取消请求，终态 409", async () => {
    seedTask({ id: "t_queue", status: "queued" });
    const queued = await call("/tickets/t_queue/stop", { method: "POST" });
    expect(queued.status).toBe(200);
    expect(store.get("t_queue")?.status).toBe("cancelled");

    seedTask({ id: "t_run", status: "running", startedAt: 1 });
    const running = await call("/tickets/t_run/stop", { method: "POST" });
    expect(running.status).toBe(200);
    const runningBody = (await running.json()) as { cancelling: boolean };
    expect(runningBody.cancelling).toBe(true);
    expect(store.isCancelRequested("t_run")).toBe(true);

    seedTask({ id: "t_done", status: "succeeded" });
    expect((await call("/tickets/t_done/stop", { method: "POST" })).status).toBe(409);
  });

  test("executor/pause 暂停接单，resume 后排队任务开跑", async () => {
    const stopped = await call("/executor/pause", { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(router.isPaused()).toBe(true);

    const started = await call("/tickets", { method: "POST", body: JSON.stringify({ prompt: "暂停期间的任务" }) });
    const startedBody = (await started.json()) as { ticket: Task };
    const ticket = startedBody.ticket;
    expect(store.get(ticket.id)?.status).toBe("queued");
    const stateRes = await call("/state");
    const state = (await stateRes.json()) as { paused: boolean };
    expect(state.paused).toBe(true);

    expect((await call("/executor/resume", { method: "POST" })).status).toBe(200);
    await waitFor(() => store.get(ticket.id)?.status === "succeeded");
  });

  test("GET /tickets/:id/logs 读 JSONL，缺文件给空数组", async () => {
    seedTask({ id: "t_log" });
    const empty = await call("/tickets/t_log/logs");
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { entries: unknown[] };
    expect(emptyBody.entries).toEqual([]);

    new TaskLogger(stateDir, "t_log").write("start", "开始");
    const res = await call("/tickets/t_log/logs");
    const { entries } = (await res.json()) as { entries: Array<{ stage: string; msg: string }> };
    expect(entries.map((e) => [e.stage, e.msg])).toEqual([["start", "开始"]]);
    expect((await call("/tickets/t_none/logs")).status).toBe(404);
  });

  test("merge：验证后快进合并，返回 needsRestart", async () => {
    createBranch("feat", "out.txt", "hi\n");
    seedTask({ id: "t_merge", status: "succeeded", branch: "feat" });

    const res = await call("/tickets/t_merge/merge", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; needsRestart: boolean };
    expect(body.ok).toBe(true);
    expect(body.needsRestart).toBe(true);
    expect(existsSync(join(repo, "out.txt"))).toBe(true);
    expect(store.effectsOf("t_merge").map((e) => e.kind)).toEqual(["merge"]);
  });

  test("rewind：默认只预览，yes 才删分支", async () => {
    createBranch("feat", "out.txt", "hi\n");
    seedTask({ id: "t_rew", status: "succeeded", branch: "feat" });
    store.effect("t_rew", "branch", "feat", "分支");

    const preview = await call("/tickets/t_rew/rewind", { method: "POST", body: JSON.stringify({}) });
    expect(preview.status).toBe(200);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "refs/heads/feat"]).code).toBe(0);

    const applied = await call("/tickets/t_rew/rewind", { method: "POST", body: JSON.stringify({ yes: true }) });
    expect(applied.status).toBe(200);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "refs/heads/feat"]).code).not.toBe(0);
    expect(store.get("t_rew")?.status).toBe("rewound");
  });

  test("方法不符返回 405，未知路径 404", async () => {
    expect((await call("/tickets")).status).toBe(405);
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/tickets/t_a/unknown", { method: "POST" })).status).toBe(404);
  });
});
