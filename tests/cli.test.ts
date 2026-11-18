import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { runCli } from "../src/cli";
import { loadConfig, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { createWebApp } from "../src/web";
import { ReplyBus } from "../src/reply-bus";
import type { ApiTarget } from "../src/api-client";
import type { WindowMetrics } from "../src/metrics";
import type { WorkerResult, Task } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh } from "../src/git";
import { newTaskId } from "../src/ids";

let root: string;
let repo: string;
let stateDir: string;
let cfgPath: string;
let cfg: Config;
let store: Store;
let router: Router;
let server: Server<unknown>;
let api: ApiTarget;

const TOKEN = "cli-test-token";

const noopWorker: WorkerRunner = {
  async run(): Promise<WorkerResult> {
    return { ok: true, summary: "", exitCode: 0 };
  },
};

function makeRepo(): string {
  const dir = join(root, "repo");
  mkdirSync(dir);
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function writeConfig(over: Record<string, unknown> = {}): void {
  writeFileSync(
    cfgPath,
    JSON.stringify({
      repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
      whitelist: { users: [process.env.USER ?? "local"], repos: ["demo"] },
      stateDir: ".pisa",
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
      ...over,
    }),
  );
}

interface Result {
  code: number;
  out: string;
  err: string;
}

/** 默认走控制面接口；omitApi 模拟 api.json 缺失（守护进程没启动） */
async function cli(...argv: string[]): Promise<Result> {
  return run([...argv], true);
}

async function cliNoApi(...argv: string[]): Promise<Result> {
  return run([...argv], false);
}

async function run(argv: string[], withApi: boolean): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t), api: withApi ? api : undefined });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

interface TaskJson {
  id: string;
  status: string;
  stage: string;
  stageLabel: string;
  repo: string;
  prompt: string;
  summary: string | null;
  error: string | null;
  branch: string | null;
  prUrl: string | null;
  baseRef: string | null;
  context: string | null;
  message?: string;
}

interface StateJson {
  daemon: { alive: boolean };
  counts: Record<string, number>;
  total: number;
  running: TaskJson[];
  queued: TaskJson[];
  finished: TaskJson[];
  executor: { paused: boolean; running: number; queued: number; concurrency: number };
  last24h: WindowMetrics;
}

/** 输出来自本进程 CLI，形状由上面的接口约束；解析失败应让测试直接报错 */
function parse<T>(result: Result): T {
  return JSON.parse(result.out) as T;
}

function base(...argv: string[]): string[] {
  return [...argv, "--config", cfgPath];
}

function seed(over: Partial<Task> = {}): Task {
  const db = new Store(join(stateDir, "pisa.db"));
  const task: Task = {
    id: newTaskId(),
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
  db.insertTask(task);
  db.close();
  return task;
}

/**
 * 等 CLI 的派活请求落到库里，再按真实状态机推进。
 * 这里只能轮询：请求经真实 HTTP 到 Bun.serve，再由另一个 SQLite 连接落库，
 * 没有可 await 的进程内信号，假时钟也推进不了网络往返。
 */
async function advanceQueued(fn: (db: Store, task: Task) => void): Promise<Task> {
  for (let i = 0; i < 1000; i += 1) {
    const db = new Store(join(stateDir, "pisa.db"));
    const task = db.nextQueued();
    if (task) {
      fn(db, task);
      const done = db.get(task.id)!;
      db.close();
      return done;
    }
    db.close();
    await Bun.sleep(10);
  }
  throw new Error("CLI 没有把任务写进队列");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pisa-cli-"));
  repo = makeRepo();
  stateDir = join(root, ".pisa");
  cfgPath = join(root, "pisa.config.json");
  writeConfig();
  cfg = loadConfig(cfgPath);
  store = new Store(join(stateDir, "pisa.db"));
  const bus = new ReplyBus("web");
  router = new Router({ cfg, store, worker: noopWorker, deliverer: new GitDeliverer(cfg), channel: bus });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createWebApp({ cfg, store, router, bus, token: TOKEN, ui: false }),
  });
  api = { url: `http://127.0.0.1:${server.port}`, token: TOKEN };
});

afterEach(async () => {
  await server.stop(true);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("config 路径锚定", () => {
  test("stateDir 与仓库相对路径以配置文件目录为基准", () => {
    const loaded = loadConfig(cfgPath);
    expect(loaded.stateDir).toBe(stateDir);
    expect(loaded.repos[0]!.path).toBe(repo);
  });
});

describe("pisa task", () => {
  test("提交任务并返回任务号", async () => {
    const r = await cli(...base("task", "修一下 CI", "--json"));
    expect(r.code).toBe(0);
    const body = parse<TaskJson>(r);
    expect(body.status).toBe("queued");
    expect(body.repo).toBe("demo");
    expect(body.id).toMatch(/^t_\d{8}_[0-9a-f]{6}$/);

    const db = new Store(join(stateDir, "pisa.db"));
    const task = db.get(body.id)!;
    expect(task.prompt).toBe("修一下 CI");
    expect(task.channel).toBe("cli");
    expect(task.requester).toBe(process.env.USER ?? "local");
    db.close();
  });

  test("守护进程不在时给出警告但仍入队", async () => {
    const r = await cli(...base("task", "修 CI"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("已入队");
    expect(r.err).toContain("没有检测到运行中的 pisa 守护进程");
  });

  test("--event-id 重试返回同一个任务", async () => {
    const first = parse<TaskJson>(await cli(...base("task", "修 CI", "--event-id", "e1", "--json")));
    const second = parse<TaskJson>(await cli(...base("task", "修 CI", "--event-id", "e1", "--json")));
    expect(second.id).toBe(first.id);
    expect(second.message).toContain("事件已存在");

    const db = new Store(join(stateDir, "pisa.db"));
    expect(db.listTasks().length).toBe(1);
    db.close();
  });

  test("--event-id 重投不同正文按编辑处理，排队任务换成最新需求", async () => {
    const first = parse<TaskJson>(await cli(...base("task", "修 CI", "--event-id", "e2", "--json")));
    const edited = parse<TaskJson>(await cli(...base("task", "修 CI 并补测试", "--event-id", "e2", "--json")));
    expect(edited.id).toBe(first.id);
    expect(edited.message).toContain("需求已按最新版本更新");

    const db = new Store(join(stateDir, "pisa.db"));
    expect(db.listTasks()[0]!.prompt).toBe("修 CI 并补测试");
    db.close();
  });

  test("未知仓库别名与未授权仓库都以待配置退出", async () => {
    expect((await cli(...base("task", "x", "--repo", "nope"))).code).toBe(3);
    writeConfig({ whitelist: { users: [process.env.USER ?? "local"], repos: ["other"] } });
    const denied = await cli(...base("task", "x", "--repo", "demo"));
    expect(denied.code).toBe(3);
    expect(denied.err).toContain("不在 whitelist.repos");
  });

  test("仓库路径不是 git 仓库时拒绝", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    writeConfig({ repos: [{ alias: "demo", path: plain }] });
    const r = await cli(...base("task", "x"));
    expect(r.code).toBe(3);
    expect(r.err).toContain("不是 git 仓库");
  });

  test("缺少需求正文是用法错误", async () => {
    expect((await cli(...base("task"))).code).toBe(4);
  });

  test("--wait 在任务成功后输出摘要", async () => {
    const pending = cli(...base("task", "修 CI", "--wait", "--timeout", "3", "--interval", "20", "--json"));
    const task = await advanceQueued((db, t) => {
      db.claimQueued(t.id, Date.now(), "pisa/x");
      db.transition(t.id, "succeeded", { summary: "改好了", endedAt: Date.now() });
    });
    const r = await pending;
    expect(r.code, r.err).toBe(0);
    expect(parse<TaskJson>(r).summary).toBe("改好了");
    expect(task.summary).toBe("改好了");
  });

  test("--wait 在任务失败时返回部件错误", async () => {
    const pending = cli(...base("task", "会失败", "--wait", "--timeout", "3", "--interval", "20", "--json"));
    await advanceQueued((db, t) => {
      db.claimQueued(t.id, Date.now(), "pisa/y");
      db.transition(t.id, "failed", { error: "编译失败", endedAt: Date.now() });
    });
    const r = await pending;
    expect(r.code).toBe(2);
    expect(parse<TaskJson>(r).error).toBe("编译失败");
  });

  test("--wait 超时返回 7，任务仍在排队", async () => {
    const r = await cli(...base("task", "慢任务", "--wait", "--timeout", "0", "--interval", "20", "--json"));
    expect(r.code).toBe(7);
    expect(parse<{ timeout: boolean; status: string }>(r)).toMatchObject({ timeout: true, status: "queued" });
  });
});

describe("pisa continue", () => {
  test("继承父任务分支与上下文", async () => {
    const parent = seed({
      status: "succeeded",
      branch: "pisa/parent",
      prUrl: "https://github.com/o/r/pull/7",
      summary: "第一轮完成",
    });
    const r = await cli(...base("continue", parent.id, "按评论再改", "--json"));
    expect(r.code).toBe(0);
    const body = parse<TaskJson>(r);
    expect(body.id).not.toBe(parent.id);

    const db = new Store(join(stateDir, "pisa.db"));
    const child = db.get(body.id)!;
    expect(child.repo).toBe("demo");
    expect(child.baseRef).toBe("pisa/parent");
    expect(child.prUrl).toBe(parent.prUrl);
    expect(child.context).toContain(parent.id);
    expect(child.context).toContain("上一轮请求：种子任务");
    db.close();
  });

  test("父任务不存在或没有分支时报错", async () => {
    expect((await cli(...base("continue", "t_missing", "x"))).code).toBe(5);
    const parent = seed();
    const r = await cli(...base("continue", parent.id, "x"));
    expect(r.code).toBe(4);
    expect(r.err).toContain("没有可续跑的分支");
  });
});

describe("查询与操作", () => {
  test("status 读接口，心跳过期返回需重启", async () => {
    seed({ prompt: "排队中" });
    const stale = await cli(...base("status"));
    expect(stale.code).toBe(1);
    expect(stale.out).toContain("排队（1）");
    expect(stale.out).toContain("等空闲槽位");
    expect(stale.out).toContain("最近 24h：完成 0");
    expect(stale.out).toContain("守护进程：未运行");

    store.beat();
    const body = parse<StateJson>(await cli(...base("status", "--json")));
    expect((await cli(...base("status"))).code).toBe(0);
    expect(body.daemon.alive).toBe(true);
    expect(body.last24h).toEqual({ finished: 0, succeeded: 0, failed: 0, successRate: null, durationSamples: 0, p50Ms: null, p95Ms: null });
    expect(body.total).toBe(1);
    expect(body.queued[0]!.prompt).toBe("排队中");
    expect(body.queued[0]!.status).toBe("queued");
    expect(body.queued[0]!.stage).toBe("working/queued");
    expect(body.queued[0]!.stageLabel).toBe("等空闲槽位");
    expect(body.executor).toMatchObject({ paused: false, concurrency: 1 });
  });

  test("接口缺失与鉴权失败分别给出需重启与待配置", async () => {
    expect((await cliNoApi(...base("status"))).code).toBe(1);
    const denied = await run([...base("status")], false);
    expect(denied.code).toBe(1);
    const badToken = await runCli([...base("status")], {
      out: () => {},
      err: () => {},
      api: { url: api.url, token: "wrong" },
    });
    expect(badToken).toBe(3);
  });

  test("show 与 logs", async () => {
    const task = seed();
    const shown = await cli(...base("show", task.id, "--json"));
    expect(shown.code).toBe(0);
    const payload = parse<{ task: TaskJson; effects: unknown[]; logTail: string[] }>(shown);
    expect(payload.task.id).toBe(task.id);
    expect(payload.task.stage).toBe("working/queued");
    expect(payload.effects).toEqual([]);

    const human = await cli(...base("show", task.id));
    expect(human.out).toContain("阶段：working/queued（等空闲槽位）");

    expect((await cli(...base("show", "t_missing"))).code).toBe(5);

    mkdirSync(join(stateDir, "logs"), { recursive: true });
    writeFileSync(join(stateDir, "logs", `${task.id}.log`), "a\nb\nc\n");
    const logs = await cli(...base("logs", task.id, "--tail", "2"));
    expect(logs.code).toBe(0);
    expect(logs.out.trim().split("\n")).toEqual(["b", "c"]);
  });

  test("list 按状态与 PR 过滤", async () => {
    seed({ prompt: "queued one" });
    seed({ prompt: "done", status: "succeeded", prUrl: "https://github.com/o/r/pull/42" });
    seed({ prompt: "other pr", status: "succeeded", prUrl: "https://github.com/o/r/pull/43" });

    const queued = parse<TaskJson[]>(await cli(...base("list", "--status", "queued", "--json")));
    expect(queued.map((t) => t.prompt)).toEqual(["queued one"]);

    const pr = parse<TaskJson[]>(await cli(...base("list", "--pr", "42", "--json")));
    expect(pr.length).toBe(1);
    expect(pr[0]!.prompt).toBe("done");

    expect((await cli(...base("list", "--status", "nope"))).code).toBe(4);
  });

  test("stop 排队任务，终态与缺失返回对应退出码", async () => {
    const queued = seed();
    expect((await cli(...base("stop", queued.id))).code).toBe(0);
    const db = new Store(join(stateDir, "pisa.db"));
    expect(db.get(queued.id)!.status).toBe("cancelled");
    db.close();

    const done = seed({ status: "succeeded" });
    expect((await cli(...base("stop", done.id))).code).toBe(6);
    expect((await cli(...base("stop", "t_missing"))).code).toBe(5);
  });

  test("retry 重开失败任务并暴露新任务号", async () => {
    const failed = seed({ status: "failed", branch: "pisa/failed", prompt: "原需求" });
    const r = await cli(...base("retry", failed.id, "--json"));
    expect(r.code, r.err).toBe(0);
    const body = parse<{ taskId: string }>(r);
    const db = new Store(join(stateDir, "pisa.db"));
    const next = db.get(body.taskId)!;
    expect(next.baseRef).toBe("pisa/failed");
    expect(next.prompt).toBe("原需求");
    expect(next.id).not.toBe(failed.id);
    db.close();

    expect((await cli(...base("retry", seed({ status: "succeeded" }).id))).code).toBe(6);
    expect((await cli(...base("retry", "t_missing"))).code).toBe(5);
  });

  test("merge 缺失与未完成的退出码", async () => {
    expect((await cli(...base("merge", "t_missing"))).code).toBe(5);
    const queued = seed();
    expect((await cli(...base("merge", queued.id))).code).toBe(6);
  });

  test("rewind 预览后执行", async () => {
    const task = seed({ status: "succeeded", branch: null });
    const plan = await cli(...base("rewind", task.id, "--json"));
    expect(plan.code, plan.err).toBe(0);
    expect(parse<{ ok: boolean; plan: { task: { id: string } } }>(plan).plan.task.id).toBe(task.id);

    expect((await cli(...base("rewind", task.id, "--yes"))).code).toBe(0);
    const db = new Store(join(stateDir, "pisa.db"));
    expect(db.get(task.id)!.status).toBe("rewound");
    db.close();
  });

  test("pause 停补位且跨重启保留，resume 恢复", async () => {
    const paused = await cli(...base("pause", "--json"));
    expect(paused.code).toBe(0);
    expect(store.executorPaused()).toBe(true);
    expect(parse<{ executor: { paused: boolean } }>(paused).executor.paused).toBe(true);
    const queued = seed();
    expect(await router.drainOnce()).toBe(false);
    const db = new Store(join(stateDir, "pisa.db"));
    expect(db.get(queued.id)!.status).toBe("queued");
    const reopened = new Store(join(stateDir, "pisa.db"));
    expect(reopened.executorPaused()).toBe(true);
    reopened.close();
    db.close();

    expect((await cli(...base("resume"))).code).toBe(0);
    expect(store.executorPaused()).toBe(false);
  });

  test("run 派活后等待终态，失败与超时给出对应退出码", async () => {
    const pending = cli(...base("run", "跑一次", "--timeout", "20", "--interval", "20", "--json"));
    await advanceQueued((db, t) => {
      db.claimQueued(t.id, Date.now(), "pisa/run");
      db.transition(t.id, "succeeded", { summary: "跑完了", endedAt: Date.now() });
    });
    const ok = await pending;
    expect(ok.code, ok.err).toBe(0);
    expect(parse<{ task: TaskJson }>(ok).task.summary).toBe("跑完了");

    const slow = await cli(...base("run", "慢任务", "--timeout", "0", "--interval", "20"));
    expect(slow.code).toBe(7);
  });

  test("repos 列出别名与授权状态", async () => {
    const body = parse<Array<Record<string, unknown>>>(await cli(...base("repos", "--json")));
    expect(body).toEqual([{ alias: "demo", path: repo, remote: null, baseBranch: "main", allowed: true }]);
  });

  test("未知命令与未知选项", async () => {
    expect((await cli(...base("nope"))).code).toBe(4);
    expect((await cli(...base("task", "x", "--bogus"))).code).toBe(4);
  });
});
