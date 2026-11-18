import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { DEFAULT_WEB, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { ReplyBus, createWebApp } from "../src/web";
import type { ChannelAdapter, DeliveryReceipt, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh } from "../src/git";
import { newTaskId } from "../src/ids";

/**
 * CLI 的读与写全部经过本机管理 API，所以测试起一个真实端口：
 * 只有真实 HTTP 才能证明「CLI 与 Web 同一套接口」。
 */
const TOKEN = "cli-token";
const TOKEN_ENV = "PISA_CLI_TEST_TOKEN";

class FakeChannel implements ChannelAdapter {
  name = "fake";
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

let root: string;
let repo: string;
let stateDir: string;
let cfgPath: string;
let cfg: Config;
let store: Store;
let router: Router;
let server: ReturnType<typeof Bun.serve>;
let port = 0;

function makeRepo(): string {
  const dir = join(root, "repo");
  mkdirSync(dir);
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function makeCfg(): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["cli-test"], repos: ["demo"] },
    repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    // 端口由真实监听决定，写入配置前回填
    web: { ...DEFAULT_WEB, enabled: true, port: 0, tokenEnv: TOKEN_ENV, userId: "cli-test" },
    stateDir,
  };
}

function writeConfig(over: Record<string, unknown> = {}): void {
  writeFileSync(
    cfgPath,
    JSON.stringify({
      trigger: cfg.trigger,
      repos: cfg.repos,
      whitelist: cfg.whitelist,
      worker: cfg.worker,
      delivery: cfg.delivery,
      stateDir,
      web: { enabled: true, port, tokenEnv: TOKEN_ENV, userId: "cli-test", chatId: "web" },
      ...over,
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
  const code = await runCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
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
  message?: string;
}

function parse<T>(result: Result): T {
  return JSON.parse(result.out) as T;
}

function base(...argv: string[]): string[] {
  return [...argv, "--config", cfgPath];
}

function seed(over: Partial<Task> = {}): Task {
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
  store.insertTask(task);
  return task;
}

beforeEach(() => {
  process.env[TOKEN_ENV] = TOKEN;
  root = mkdtempSync(join(tmpdir(), "pisa-cli-"));
  repo = makeRepo();
  stateDir = join(root, ".pisa");
  cfgPath = join(root, "pisa.config.json");
  cfg = makeCfg();
  store = new Store(join(stateDir, "pisa.db"));
  const bus = new ReplyBus("web", new FakeChannel());
  router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
  const app = createWebApp({ cfg, store, router, bus, token: TOKEN, configPath: cfgPath });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app });
  port = server.port ?? 0;
  cfg.web!.port = port;
  writeConfig();
});

afterEach(() => {
  server.stop(true);
  store.close();
  delete process.env[TOKEN_ENV];
  rmSync(root, { recursive: true, force: true });
});

describe("退出码 3：待配置", () => {
  test("缺少配置文件", async () => {
    rmSync(cfgPath);
    const r = await cli(...base("status"));
    expect(r.code).toBe(3);
    expect(r.err).toContain("找不到配置文件");
  });

  test("web 未启用", async () => {
    writeConfig({ web: { enabled: false, port, tokenEnv: TOKEN_ENV } });
    const r = await cli(...base("status"));
    expect(r.code).toBe(3);
    expect(r.err).toContain("管理 API 未启用");
  });

  test("缺少 token 环境变量", async () => {
    delete process.env[TOKEN_ENV];
    const r = await cli(...base("status"));
    expect(r.code).toBe(3);
    expect(r.err).toContain(TOKEN_ENV);
  });

  test("token 不匹配", async () => {
    process.env[TOKEN_ENV] = "wrong";
    const r = await cli(...base("status"));
    expect(r.code).toBe(3);
    expect(r.err).toContain("token 被拒绝");
  });
});

describe("退出码 2：部件错误", () => {
  test("管理 API 不可达", async () => {
    server.stop(true);
    const r = await cli(...base("status"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("管理 API 不可达");
  });

  test("未知命令、未知选项与非法状态", async () => {
    expect((await cli(...base("nope"))).code).toBe(2);
    expect((await cli(...base("run", "x", "--bogus"))).code).toBe(2);
    expect((await cli(...base("list", "--status", "nope"))).code).toBe(2);
  });
});

describe("pisa run", () => {
  test("提交任务并返回任务号", async () => {
    store.beat();
    const r = await cli(...base("run", "修一下 CI", "--json"));
    expect(r.code).toBe(0);
    const body = parse<TaskJson>(r);
    expect(body.status).toBe("queued");
    expect(body.repo).toBe("demo");
    expect(body.id).toMatch(/^t_\d{8}_[0-9a-f]{6}$/);
    const task = store.get(body.id)!;
    expect(task.prompt).toBe("修一下 CI");
    expect(task.channel).toBe("cli");
    expect(task.requester).toBe(process.env.USER ?? "local");
  });

  test("守护进程心跳过期时提示但仍入队", async () => {
    const r = await cli(...base("run", "修 CI"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("已入队");
    expect(r.err).toContain("心跳已过期");
  });

  test("--event-id 幂等", async () => {
    const first = parse<TaskJson>(await cli(...base("run", "修 CI", "--event-id", "e1", "--json")));
    const second = parse<TaskJson>(await cli(...base("run", "修 CI", "--event-id", "e1", "--json")));
    expect(second.id).toBe(first.id);
    expect(second.message).toContain("事件已存在");
    expect(store.listTasks()).toHaveLength(1);
  });

  test("仓库校验在本地完成", async () => {
    const unknown = await cli(...base("run", "x", "--repo", "nope"));
    expect(unknown.code).toBe(2);
    writeConfig({ whitelist: { users: [], repos: ["other"] } });
    const denied = await cli(...base("run", "x", "--repo", "demo"));
    expect(denied.code).toBe(2);
    expect(denied.err).toContain("不在 whitelist.repos");
    expect((await cli(...base("run"))).code).toBe(2);
  });

  test("--wait 成功返回 0，失败返回 2，超时返回 2", async () => {
    const done = cli(...base("run", "会成功", "--wait", "--timeout", "3", "--interval", "20", "--json"));
    await router.drainOnce();
    const ok = await done;
    expect(ok.code, ok.err).toBe(0);
    expect(parse<TaskJson>(ok).summary).toBe("改了 out.txt");

    const failed = cli(...base("run", "会失败", "--wait", "--timeout", "3", "--interval", "20", "--json"));
    const task = store.nextQueued()!;
    store.claimQueued(task.id, Date.now(), "pisa/y");
    store.transition(task.id, "failed", { error: "编译失败", endedAt: Date.now() });
    const bad = await failed;
    expect(bad.code).toBe(2);
    expect(parse<TaskJson>(bad).error).toBe("编译失败");

    const slow = await cli(...base("run", "慢任务", "--wait", "--timeout", "0", "--interval", "20", "--json"));
    expect(slow.code).toBe(2);
    expect(parse<{ timeout: boolean }>(slow).timeout).toBe(true);
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
    const child = store.get(body.id)!;
    expect(child.baseRef).toBe("pisa/parent");
    expect(child.prUrl).toBe(parent.prUrl);
    expect(child.context).toContain(parent.id);
    expect(child.context).toContain("上一轮请求：种子任务");
  });

  test("父任务不存在或没有分支时报错", async () => {
    expect((await cli(...base("continue", "t_missing", "x"))).code).toBe(2);
    const parent = seed();
    const r = await cli(...base("continue", parent.id, "x"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("没有可续跑的分支");
  });
});

describe("查询", () => {
  test("status 输出看板与执行器状态", async () => {
    seed({ prompt: "排队中" });
    store.beat();
    const text = await cli(...base("status"));
    expect(text.code).toBe(0);
    expect(text.out).toContain("排队（1）");
    expect(text.out).toContain("working/queued（等空闲槽位）");
    expect(text.out).toContain("守护进程：运行中");
    expect(text.out).toContain("执行器：运行中");

    const body = parse<{
      daemon: { alive: boolean };
      total: number;
      worker: { paused: boolean; concurrency: number };
      repos: string[];
      text: string;
    }>(await cli(...base("status", "--json")));
    expect(body.daemon.alive).toBe(true);
    expect(body.total).toBe(1);
    expect(body.worker).toMatchObject({ paused: false, concurrency: 1 });
    expect(body.repos).toEqual(["demo"]);
    expect(body.text).toContain("排队（1）");
  });

  test("show 与 logs", async () => {
    const task = seed();
    const shown = await cli(...base("show", task.id, "--json"));
    expect(shown.code).toBe(0);
    expect(parse<TaskJson>(shown).id).toBe(task.id);
    expect(parse<TaskJson>(shown).stage).toBe("working/queued");
    expect((await cli(...base("show", task.id))).out).toContain("阶段：working/queued（等空闲槽位）");
    expect((await cli(...base("show", "t_missing"))).code).toBe(2);

    mkdirSync(join(stateDir, "logs"), { recursive: true });
    writeFileSync(join(stateDir, "logs", `${task.id}.log`), "a\nb\nc\n");
    const logs = await cli(...base("logs", task.id, "--tail", "2"));
    expect(logs.code).toBe(0);
    expect(logs.out.trim().split("\n")).toEqual(["b", "c"]);
    const asJson = parse<{ lines: string[] }>(await cli(...base("logs", task.id, "--tail", "1", "--json")));
    expect(asJson.lines).toEqual(["c"]);
  });

  test("list 按状态与 PR 过滤", async () => {
    seed({ prompt: "queued one" });
    seed({ prompt: "done", status: "succeeded", prUrl: "https://github.com/o/r/pull/42" });
    seed({ prompt: "other pr", status: "succeeded", prUrl: "https://github.com/o/r/pull/43" });

    const queued = parse<TaskJson[]>(await cli(...base("list", "--status", "queued", "--json")));
    expect(queued.map((t) => t.prompt)).toEqual(["queued one"]);
    const pr = parse<TaskJson[]>(await cli(...base("list", "--pr", "42", "--json")));
    expect(pr.map((t) => t.prompt)).toEqual(["done"]);
    const human = await cli(...base("list"));
    expect(human.out).toContain("queued one");
  });

  test("repos 列出别名与授权状态", async () => {
    const body = parse<Array<Record<string, unknown>>>(await cli(...base("repos", "--json")));
    expect(body).toEqual([{ alias: "demo", path: repo, remote: null, baseBranch: "main", allowed: true }]);
  });
});

describe("操作", () => {
  test("cancel 排队任务，终态任务被拒", async () => {
    const queued = seed();
    const cancelled = await cli(...base("cancel", queued.id));
    expect(cancelled.code, ` || `).toBe(0);
    expect(store.get(queued.id)!.status).toBe("cancelled");

    const done = seed({ status: "succeeded" });
    expect((await cli(...base("cancel", done.id))).code).toBe(2);
    expect((await cli(...base("cancel", "t_missing"))).code).toBe(2);
  });

  test("retry 为失败任务新建一次运行", async () => {
    const failed = seed({ status: "failed", prompt: "原需求", error: "炸了" });
    const r = await cli(...base("retry", failed.id, "--json"));
    expect(r.code).toBe(0);
    const retried = parse<{ taskId: string; message: string }>(r);
    expect(retried.taskId).not.toBe(failed.id);
    expect(store.get(retried.taskId)!.prompt).toBe("原需求");

    const running = seed({ status: "running", startedAt: Date.now() });
    const refused = await cli(...base("retry", running.id));
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("仍在进行");
  });

  test("merge 需要 --yes，且只在成功后合并", async () => {
    const refused = await cli(...base("merge", "t_any"));
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("--yes");

    const queued = seed({ status: "queued" });
    expect((await cli(...base("merge", queued.id, "--yes"))).code).toBe(2);
    expect(store.effectsOf(queued.id)).toHaveLength(0);

    const dispatched = parse<{ id: string }>(await cli(...base("run", "新建 out.txt", "--json")));
    await router.drainOnce();
    const supervised = process.env.PISA_SUPERVISED;
    delete process.env.PISA_SUPERVISED;
    try {
      const r = await cli(...base("merge", dispatched.id, "--yes"));
      expect(r.code, ` || `).toBe(0);
      expect(store.effectsOf(dispatched.id).some((e) => e.kind === "merge")).toBe(true);
    } finally {
      if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
    }
  });

  test("rewind 预览与执行", async () => {
    const task = seed({ status: "succeeded" });
    const preview = await cli(...base("rewind", task.id));
    expect(preview.code).toBe(0);
    const executed = await cli(...base("rewind", task.id, "--yes", "--json"));
    expect(executed.code).toBe(0);
    expect(store.get(task.id)!.status).toBe("rewound");
  });

  test("executor pause 后不再领取任务，resume 恢复", async () => {
    expect((await cli(...base("executor", "pause"))).code).toBe(0);
    expect(router.executorPaused).toBe(true);
    seed();
    await router.drainOnce();
    expect(store.countByStatus().queued).toBe(1);
    expect((await cli(...base("executor", "resume"))).code).toBe(0);
    expect(router.executorPaused).toBe(false);
    await router.drainOnce();
    expect(store.countByStatus().queued).toBe(0);
    expect((await cli(...base("executor", "nope"))).code).toBe(2);
  });

  test("config 查看与保存：保存后退出码 1", async () => {
    const shown = await cli(...base("config", "--json"));
    expect(shown.code).toBe(0);
    expect(parse<{ path: string }>(shown).path).toBe(cfgPath);

    const patch = join(root, "patch.json");
    writeFileSync(
      patch,
      JSON.stringify({
        repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
        worker: { adapter: "omp", command: "noop", concurrency: 2, timeoutSec: 9 },
        schedules: [],
      }),
    );
    expect((await cli(...base("config", "--set", patch))).code).toBe(2);
    const saved = await cli(...base("config", "--set", patch, "--yes"));
    expect(saved.code).toBe(1);
    const written = JSON.parse(await Bun.file(cfgPath).text()) as { worker: { concurrency: number } };
    expect(written.worker.concurrency).toBe(2);
  });
});
