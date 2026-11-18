import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { loadConfig, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { ReplyBus, startWebServer, type WebServer } from "../src/web";
import type { ChannelAdapter, DeliveryReceipt, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh } from "../src/git";

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
let server: WebServer;

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
      web: { enabled: true, port: 0, tokenEnv: "PISA_WEB_TOKEN", userId: "cli", chatId: "cli" },
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

function parse<T>(result: Result): T {
  return JSON.parse(result.out) as T;
}

function base(...argv: string[]): string[] {
  return [...argv, "--config", cfgPath];
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pisa-cli-"));
  repo = makeRepo();
  stateDir = join(root, ".pisa");
  cfgPath = join(root, "pisa.config.json");
  writeConfig();
  process.env.PISA_WEB_TOKEN = "cli-token";
  cfg = loadConfig(cfgPath);
  store = new Store(join(stateDir, "pisa.db"));
  store.beat();
  const bus = new ReplyBus("cli", new FakeChannel());
  router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
  server = startWebServer({ cfg, store, router, bus }, cfg.web!);
  process.env.PISA_API_URL = server.base;
});

afterEach(async () => {
  await server.stop();
  store.close();
  delete process.env.PISA_API_URL;
  delete process.env.PISA_WEB_TOKEN;
  rmSync(root, { recursive: true, force: true });
});

/** 等条件成立，而不是猜一个固定等待时间 */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("条件在 2s 内没有成立");
}

function seed(over: Partial<Task> = {}): Task {
  const task: Task = {
    id: "t_seed",
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

describe("配置", () => {
  test("stateDir 与仓库相对路径以配置文件目录为基准", () => {
    expect(cfg.stateDir).toBe(stateDir);
    expect(cfg.repos[0]!.path).toBe(repo);
  });

  test("配置文件缺失退出 3", async () => {
    const r = await cli("status", "--config", join(root, "nope.json"));
    expect(r.code).toBe(3);
    expect(r.err).toContain("找不到配置文件");
  });

  test("非回环接口地址退出 3", async () => {
    process.env.PISA_API_URL = "http://10.0.0.1:8787";
    const r = await cli(...base("status"));
    expect(r.code).toBe(3);
    expect(r.err).toContain("回环");
  });
});

describe("pisa run", () => {
  test("提交任务并返回任务号", async () => {
    const r = await cli(...base("run", "修一下 CI", "--json"));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const body = parse<{ id: string; status: string; statusLabel: string; repo: string }>(r);
    expect(body.status).toBe("queued");
    expect(body.statusLabel).toBe("排队");
    expect(body.repo).toBe("demo");
    expect(body.id).toMatch(/^t_\d{8}_[0-9a-f]{6}$/);

    const task = store.get(body.id)!;
    expect(task.prompt).toBe("修一下 CI");
    expect(task.requester).toBe(process.env.USER ?? cfg.web!.userId);
  });

  test("守护进程心跳过期时仍入队但退出 1", async () => {
    store.beat(Date.now() - 60_000);
    const r = await cli(...base("run", "修 CI"));
    expect(r.code).toBe(1);
    expect(r.out).toContain("状态：排队");
    expect(r.err).toContain("心跳已过期");
    expect(store.listTasks().length).toBe(1);
  });

  test("--event-id 重投返回同一个任务", async () => {
    const first = parse<{ id: string }>(await cli(...base("run", "修 CI", "--event-id", "e1", "--json")));
    const second = parse<{ id: string }>(await cli(...base("run", "修 CI", "--event-id", "e1", "--json")));
    expect(second.id).toBe(first.id);
    expect(store.listTasks().length).toBe(1);
  });

  test("--event-id 重投不同正文按编辑处理", async () => {
    const first = parse<{ id: string }>(await cli(...base("run", "修 CI", "--event-id", "e2", "--json")));
    await cli(...base("run", "修 CI 并补测试", "--event-id", "e2", "--json"));
    expect(store.listTasks()[0]!.id).toBe(first.id);
    expect(store.get(first.id)!.prompt).toBe("修 CI 并补测试");
  });

  test("空正文退出 2", async () => {
    const r = await cli(...base("run", "  "));
    expect(r.code).toBe(2);
    expect(r.err).toContain("用法");
    expect(store.listTasks()).toHaveLength(0);
  });

  test("未授权仓库退出 3", async () => {
    cfg.whitelist.repos = ["other"];
    const r = await cli(...base("run", "x"));
    expect(r.code).toBe(3);
    expect(store.listTasks()).toHaveLength(0);
  });

  test("未授权 token 退出 3", async () => {
    process.env.PISA_WEB_TOKEN = "wrong";
    const r = await cli(...base("run", "x"));
    expect(r.code).toBe(3);
    expect(r.err).toContain("未授权");
  });

  test("--wait 等到成功退出 0", async () => {
    const pending = cli(...base("run", "写个文件", "--wait", "--timeout", "10", "--interval", "0.05"));
    await until(() => store.listTasks().length === 1);
    await router.drainOnce();
    const r = await pending;
    expect(r.code).toBe(0);
    expect(store.listTasks().length).toBe(1);
  });

  test("--wait 任务失败退出 2", async () => {
    const task = seed();
    store.transition(task.id, "running", { startedAt: Date.now() });
    store.transition(task.id, "failed", { error: "炸了" });
    const r = await cli(...base("wait", task.id));
    expect(r.code).toBe(2);
    expect(r.err).toContain("failed");
  });

  test("等待超时退出 2", async () => {
    const task = seed();
    store.transition(task.id, "running", { startedAt: Date.now() });
    const r = await cli(...base("wait", task.id, "--timeout", "0.1", "--interval", "0.02"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("等待超时");
  });
});

describe("pisa status", () => {
  test("输出守护进程、执行器与看板", async () => {
    seed({ id: "t_boot", status: "queued", prompt: "排队" });
    const r = await cli(...base("status"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("守护进程：运行中");
    expect(r.out).toContain("执行器：运行中");
    expect(r.out).toContain("t_boot");
  });

  test("--json 输出状态对象并反映暂停", async () => {
    await fetch(`${server.base}/executor/pause`, { method: "POST", headers: { "x-pisa-token": server.token } });
    const r = await cli(...base("status", "--json"));
    expect(r.code).toBe(0);
    const body = parse<{ daemon: { alive: boolean }; executor: { paused: boolean }; repos: Array<{ alias: string }> }>(r);
    expect(body.daemon.alive).toBe(true);
    expect(body.executor.paused).toBe(true);
    expect(body.repos.map((x) => x.alias)).toEqual(["demo"]);
  });

  test("心跳过期退出 1", async () => {
    store.beat(Date.now() - 60_000);
    const r = await cli(...base("status"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("心跳已过期");
  });

  test("接口不可达退出 1，--json 给出 ok:false", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const dead = `http://127.0.0.1:${probe.port}`;
    await probe.stop(true);
    process.env.PISA_API_URL = dead;
    const r = await cli(...base("status", "--json"));
    expect(r.code).toBe(1);
    expect(parse<{ ok: boolean; error: string }>(r).ok).toBe(false);

    const down = await cli(...base("run", "x"));
    expect(down.code).toBe(1);
    expect(down.err).toContain("守护进程可能没启动");
  });
});

describe("查询与操作", () => {
  test("list 按状态过滤，非法状态退出 2", async () => {
    seed({ id: "t_a", status: "queued" });
    seed({ id: "t_b", status: "queued" });
    store.transition("t_b", "running", { startedAt: Date.now() });
    store.transition("t_b", "succeeded", { endedAt: Date.now() });

    const r = await cli(...base("list", "--status", "queued", "--json"));
    expect(r.code).toBe(0);
    expect(parse<Array<{ id: string; statusLabel: string }>>(r).map((t) => t.id)).toEqual(["t_a"]);
    expect(parse<Array<{ statusLabel: string }>>(r)[0]!.statusLabel).toBe("排队");

    const bad = await cli(...base("list", "--status", "nope"));
    expect(bad.code).toBe(2);
  });

  test("show 与 logs 走接口", async () => {
    const task = seed({ id: "t_show", prompt: "看日志" });
    mkdirSync(join(stateDir, "logs"), { recursive: true });
    writeFileSync(join(stateDir, "logs", `${task.id}.log`), `${["一", "二", "三"].join("\n")}\n`);

    const show = await cli(...base("show", task.id, "--json"));
    expect(show.code).toBe(0);
    expect(parse<{ ticket: { id: string; prompt: string } }>(show).ticket.prompt).toBe("看日志");

    const logs = await cli(...base("logs", task.id, "--tail", "2", "--json"));
    expect(logs.code).toBe(0);
    expect(parse<{ lines: string[] }>(logs).lines).toEqual(["二", "三"]);

    expect((await cli(...base("show", "t_missing"))).code).toBe(2);
  });

  test("stop 排队任务退出 0", async () => {
    seed({ id: "t_stop" });
    const r = await cli(...base("stop", "t_stop", "--json"));
    expect(r.code).toBe(0);
    expect(parse<{ ticket: { status: string } }>(r).ticket.status).toBe("cancelled");
    expect(store.get("t_stop")!.status).toBe("cancelled");
    expect((await cli(...base("stop", "t_missing"))).code).toBe(2);
  });

  test("retry 失败任务退出 0，成功任务冲突退出 2", async () => {
    const task = seed({ id: "t_retry" });
    store.transition(task.id, "running", { startedAt: Date.now() });
    store.transition(task.id, "failed", { error: "炸了" });
    const r = await cli(...base("retry", task.id, "--json"));
    expect(r.code).toBe(0);
    expect(store.get(task.id)!.status).toBe("queued");

    store.transition(task.id, "running", { startedAt: Date.now() });
    store.transition(task.id, "failed", { error: "再炸" });
    store.transition(task.id, "queued");
    store.transition(task.id, "running", { startedAt: Date.now() });
    store.transition(task.id, "succeeded", { endedAt: Date.now() });
    expect((await cli(...base("retry", task.id))).code).toBe(2);
  });

  test("rewind 默认只预览，--yes 才执行", async () => {
    seed({ id: "t_rewind", status: "cancelled" });
    const preview = await cli(...base("rewind", "t_rewind", "--json"));
    expect(preview.code).toBe(0);
    expect(parse<{ applied: boolean }>(preview).applied).toBe(false);
    expect(store.get("t_rewind")!.status).toBe("cancelled");

    const applied = await cli(...base("rewind", "t_rewind", "--yes", "--json"));
    expect(applied.code).toBe(0);
    expect(store.get("t_rewind")!.status).toBe("rewound");
  });

  test("repos 只读本地配置", async () => {
    const r = await cli(...base("repos", "--json"));
    expect(r.code).toBe(0);
    expect(parse<Array<{ alias: string }>>(r).map((x) => x.alias)).toEqual(["demo"]);
  });
});

describe("pisa merge", () => {
  test("合并成功后退出 1 提示重启", async () => {
    const supervised = process.env.PISA_SUPERVISED;
    delete process.env.PISA_SUPERVISED;
    try {
      const pending = cli(...base("run", "新建 out.txt", "--wait", "--timeout", "10", "--interval", "0.05"));
      await until(() => store.listTasks().length === 1);
      await router.drainOnce();
      const submitted = await pending;
      expect(submitted.code).toBe(0);
      const id = store.listTasks()[0]!.id;

      const r = await cli(...base("merge", id, "--json"));
      expect(r.code).toBe(1);
      expect(r.err).toContain("重启");
      expect(parse<{ restartRequired: boolean }>(r).restartRequired).toBe(true);
      expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).toBe(0);
    } finally {
      if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
    }
  });

  test("未成功的任务退出 2", async () => {
    seed({ id: "t_queued" });
    expect((await cli(...base("merge", "t_queued"))).code).toBe(2);
    expect((await cli(...base("merge", "t_missing"))).code).toBe(2);
  });
});

describe("帮助与用法", () => {
  test("help 列出命令与退出码", async () => {
    const r = await cli("help");
    expect(r.code).toBe(0);
    for (const word of ["run", "retry", "merge", "rewind", "退出码", "3  待配置"]) expect(r.out).toContain(word);
  });

  test("未知命令与未知选项退出 2", async () => {
    expect((await cli(...base("nope"))).code).toBe(2);
    expect((await cli(...base("status", "--nope"))).code).toBe(2);
  });
});
