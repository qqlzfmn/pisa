import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { DEFAULT_WEB, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { ReplyBus, startWebServer, type WebServer } from "../src/web";
import { newTaskId } from "../src/ids";
import { sh } from "../src/git";
import type { ChannelAdapter, DeliveryReceipt, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";

class SilentChannel implements ChannelAdapter {
  name = "silent";
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

const TOKEN_ENV = "PISA_MGMT_TEST_TOKEN";
const TOKEN = "mgmt-secret";

let root: string;
let repo: string;
let stateDir: string;
let cfgPath: string;
let store: Store;
let cfg: Config;
let router: Router;
let web: WebServer;

function makeRepo(): string {
  const dir = join(root, "repo");
  mkdirSync(dir);
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function writeConfigFile(port: number): void {
  writeFileSync(
    cfgPath,
    JSON.stringify({
      repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
      whitelist: { users: ["tester"], repos: ["demo"] },
      stateDir: ".pisa",
      worker: { adapter: "omp", command: "bun", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      web: { ...DEFAULT_WEB, enabled: true, port, tokenEnv: TOKEN_ENV, userId: "tester", chatId: "web" },
    }),
  );
}

interface Result {
  code: number;
  out: string;
  err: string;
}

async function cli(...argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...argv, "--config", cfgPath], { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function parse<T>(result: Result): T {
  return JSON.parse(result.out) as T;
}

function seed(over: Partial<Task> & { id?: string } = {}): Task {
  const id = over.id ?? newTaskId();
  const task: Task = {
    id,
    source: "cli",
    channel: "cli",
    chatId: "cli",
    requester: "tester",
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
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
    ...over,
  };
  store.insertTask(task);
  return task;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pisa-mgmt-"));
  repo = makeRepo();
  stateDir = join(root, ".pisa");
  cfgPath = join(root, "pisa.config.json");
  process.env[TOKEN_ENV] = TOKEN;
  store = new Store(join(stateDir, "pisa.db"));
  cfg = {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["tester"], repos: ["demo"] },
    repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
    worker: { adapter: "omp", command: "bun", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    web: { ...DEFAULT_WEB, enabled: true, port: 0, tokenEnv: TOKEN_ENV, userId: "tester", chatId: "web" },
    stateDir,
    configPath: cfgPath,
  };
  const bus = new ReplyBus("web", new SilentChannel());
  router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
  web = startWebServer({ cfg, store, router, bus }, cfg.web!);
  const port = web.server.port!;
  cfg.web!.port = port;
  writeConfigFile(port);
});

afterEach(async () => {
  await web.stop();
  store.close();
  delete process.env[TOKEN_ENV];
  rmSync(root, { recursive: true, force: true });
});

describe("管理接口与 CLI 同源", () => {
  test("status 走接口，退出码 0", async () => {
    seed({ prompt: "排队中" });
    const r = await cli("status", "--json");
    expect(r.code).toBe(0);
    const body = parse<{ source: string; executor: { paused: boolean; concurrency: number }; health: { code: number }; queued: Array<{ prompt: string }> }>(r);
    expect(body.source).toBe("api");
    expect(body.executor.paused).toBe(false);
    expect(body.health.code).toBe(0);
    expect(body.queued[0]!.prompt).toBe("排队中");
  });

  test("retry 建新任务，重复请求幂等", async () => {
    const failed = seed({ status: "failed" });
    const first = await cli("retry", failed.id, "--json");
    expect(first.code).toBe(0);
    const firstBody = parse<{ ok: boolean; taskId: string }>(first);
    expect(store.get(firstBody.taskId)!.status).toBe("queued");
    expect(store.get(firstBody.taskId)!.prompt).toBe(failed.prompt);

    const second = parse<{ taskId: string }>(await cli("retry", failed.id, "--json"));
    expect(second.taskId).toBe(firstBody.taskId);
  });

  test("retry 的状态不允许退出 4，找不到退出 3", async () => {
    const queued = seed();
    const rejected = await cli("retry", queued.id);
    expect(rejected.code).toBe(4);
    expect(rejected.err).toContain("只有失败、取消或撤销的任务可以重试");

    expect((await cli("retry", "t_missing")).code).toBe(3);
  });

  test("cancel 走接口，重复取消退出 4", async () => {
    const queued = seed();
    const cancelled = parse<{ ok: boolean; taskId: string }>(await cli("cancel", queued.id, "--json"));
    expect(cancelled).toMatchObject({ ok: true, taskId: queued.id });
    expect(store.get(queued.id)!.status).toBe("cancelled");
    expect((await cli("cancel", queued.id)).code).toBe(4);
  });

  test("executor pause/resume 生效", async () => {
    expect((await cli("executor", "pause", "--json")).code).toBe(0);
    expect(router.executorState().paused).toBe(true);
    const paused = parse<{ executor: { paused: boolean } }>(await cli("status", "--json"));
    expect(paused.executor.paused).toBe(true);
    expect((await cli("executor", "resume")).code).toBe(0);
    expect(router.executorState().paused).toBe(false);
  });

  test("merge 与 rewind 走接口", async () => {
    const created = parse<{ id: string }>(await cli("task", "新建 out.txt", "--json"));
    await router.drainOnce();
    const merged = await cli("merge", created.id, "--json");
    expect(merged.code).toBe(0);
    expect(store.effectsOf(created.id).some((e) => e.kind === "merge")).toBe(true);

    const preview = await cli("rewind", created.id, "--json");
    expect(preview.code).toBe(0);
    expect(parse<{ message: string }>(preview).message).toContain("撤销");
    expect(store.get(created.id)!.status).toBe("succeeded");
  });

  test("错误 token 退出 3", async () => {
    process.env[TOKEN_ENV] = "wrong";
    const r = await cli("executor", "pause");
    expect(r.code).toBe(3);
    expect(r.err).toContain("拒绝凭证");
  });
});

describe("越权", () => {
  test("非管理员只能操作自己的任务", async () => {
    const task = seed({ status: "queued" });
    const intruder = { userId: "intruder" };
    expect((await router.cancelTask(task.id, intruder)).message).toContain("只有原请求者可以取消");
    expect((await router.retryTask(seed({ status: "failed", requester: "tester" }).id, intruder)).message).toContain("只有原请求者可以重试");
    expect((await router.mergeTask(task.id, { actor: intruder })).message).toContain("只有原请求者可以合并");
    expect((await router.rewindTask(task.id, { actor: intruder })).message).toContain("只有原请求者可以撤销");
    expect(store.get(task.id)!.status).toBe("queued");
  });

  test("请求头缺失时接口拒绝", async () => {
    const res = await fetch(`http://127.0.0.1:${web.server.port}/api/state?token=${TOKEN}`);
    expect(res.status).toBe(401);
  });
});
