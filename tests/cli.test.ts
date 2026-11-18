import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, EXIT } from "../src/cli";
import { loadConfig, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { ReplyBus, createWebApp } from "../src/web";
import { sh } from "../src/git";
import { newTaskId } from "../src/ids";
import type { ChannelAdapter, DeliveryReceipt, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";

const TOKEN_ENV = "PISA_CLI_TEST_TOKEN";
const TOKEN = "cli-token";

class FakeChannel implements ChannelAdapter {
  name = "fake";
  async start(): Promise<void> {}
  async send(_chatId: string, _text: string): Promise<DeliveryReceipt> {
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
interface TestServer {
  port?: number;
  stop(force?: boolean): void;
}

let server: TestServer;

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
      whitelist: { users: ["tester"], repos: ["demo"] },
      stateDir: ".pisa",
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
      web: { enabled: true, port: 0, tokenEnv: TOKEN_ENV, userId: "tester", chatId: "web" },
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
  context: string | null;
  message?: string;
}

interface StateJson {
  daemon: { alive: boolean };
  executor: { paused: boolean; running: number; concurrency: number };
  total: number;
  queued: TaskJson[];
}

/** 输出来自本进程 CLI，形状由上面的接口约束；解析失败应让测试直接报错 */
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
  root = mkdtempSync(join(tmpdir(), "pisa-cli-"));
  repo = makeRepo();
  stateDir = join(root, ".pisa");
  mkdirSync(stateDir, { recursive: true });
  cfgPath = join(root, "pisa.config.json");
  writeConfig();

  store = new Store(join(stateDir, "pisa.db"));
  cfg = loadConfig(cfgPath);
  const bus = new ReplyBus("web", new FakeChannel());
  router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
  const app = createWebApp({ cfg, store, router, bus, token: TOKEN });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app });
  // CLI 按配置里的 web.port 找服务，端口由系统分配
  const port = server.port;
  if (!port) throw new Error("Bun.serve 没有分配端口");
  writeConfig({ web: { enabled: true, port, tokenEnv: TOKEN_ENV, userId: "tester", chatId: "web" } });
  process.env[TOKEN_ENV] = TOKEN;
  delete process.env.PISA_SUPERVISED;
});

afterEach(() => {
  server.stop(true);
  store.close();
  delete process.env[TOKEN_ENV];
  rmSync(root, { recursive: true, force: true });
});

describe("退出码 3 待配置", () => {
  test("缺少 token", async () => {
    delete process.env[TOKEN_ENV];
    const r = await cli(...base("status"));
    expect(r.code).toBe(EXIT.config);
    expect(r.err).toContain(TOKEN_ENV);
  });

  test("token 不匹配", async () => {
    process.env[TOKEN_ENV] = "wrong";
    const r = await cli(...base("status"));
    expect(r.code).toBe(EXIT.config);
    expect(r.err).toContain("token 不匹配");
  });

  test("配置文件不存在", async () => {
    const r = await cli("status", "--config", join(root, "missing.json"));
    expect(r.code).toBe(EXIT.config);
  });

  test("未知仓库别名", async () => {
    const r = await cli(...base("run", "x", "--repo", "nope"));
    expect(r.code).toBe(EXIT.config);
    expect(r.err).toContain("仓库未配置");
  });

  test("未授权仓库", async () => {
    cfg.whitelist.repos = ["other"];
    const denied = await cli(...base("run", "x", "--repo", "demo"));
    expect(denied.code).toBe(EXIT.config);
    expect(denied.err).toContain("不在白名单");
  });

  test("仓库路径不是 git 仓库", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    cfg.repos[0]!.path = plain;
    const r = await cli(...base("run", "x"));
    expect(r.code).toBe(EXIT.config);
    expect(r.err).toContain("不是 git 仓库");
  });
});

describe("退出码 2 部件错误", () => {
  test("守护进程不在", async () => {
    const r = await cli(...base("status", "--url", "http://127.0.0.1:1"));
    expect(r.code).toBe(EXIT.component);
    expect(r.err).toContain("无法连接管理 API");
  });

  test("缺少需求正文", async () => {
    expect((await cli(...base("run"))).code).toBe(EXIT.component);
  });

  test("未知命令、未知选项与未知状态", async () => {
    expect((await cli(...base("nope"))).code).toBe(EXIT.component);
    expect((await cli(...base("run", "x", "--bogus"))).code).toBe(EXIT.component);
    expect((await cli(...base("list", "--status", "nope"))).code).toBe(EXIT.component);
  });

  test("找不到任务与终态冲突", async () => {
    expect((await cli(...base("show", "t_missing"))).code).toBe(EXIT.component);
    expect((await cli(...base("stop", "t_missing"))).code).toBe(EXIT.component);
    const done = seed({ status: "succeeded" });
    expect((await cli(...base("stop", done.id))).code).toBe(EXIT.component);
  });
});

describe("run", () => {
  test("提交任务并返回任务号", async () => {
    const r = await cli(...base("run", "修一下 CI", "--json"));
    expect(r.code).toBe(EXIT.ok);
    const body = parse<TaskJson>(r);
    expect(body.status).toBe("queued");
    expect(body.repo).toBe("demo");
    expect(body.id).toMatch(/^t_\d{8}_[0-9a-f]{6}$/);

    const task = store.get(body.id)!;
    expect(task.prompt).toBe("修一下 CI");
    expect(task.channel).toBe("web");
    expect(task.requester).toBe("tester");
  });

  test("--event-id 重投返回同一个任务", async () => {
    const first = parse<TaskJson>(await cli(...base("run", "修 CI", "--event-id", "e1", "--json")));
    const second = parse<TaskJson>(await cli(...base("run", "修 CI", "--event-id", "e1", "--json")));
    expect(second.id).toBe(first.id);
    expect(store.listTasks().length).toBe(1);
  });

  test("--event-id 重投不同正文按编辑处理", async () => {
    const first = parse<TaskJson>(await cli(...base("run", "修 CI", "--event-id", "e2", "--json")));
    const edited = parse<TaskJson>(await cli(...base("run", "修 CI 并补测试", "--event-id", "e2", "--json")));
    expect(edited.id).toBe(first.id);
    expect(edited.message).toContain("已按最新版本更新需求");
    expect(store.listTasks()[0]!.prompt).toBe("修 CI 并补测试");
  });

  test("--wait 成功后输出摘要", async () => {
    const submitted = parse<TaskJson>(await cli(...base("run", "修 CI", "--json")));
    const pending = cli(...base("wait", submitted.id, "--timeout", "5", "--interval", "20", "--json"));
    const task = store.get(submitted.id)!;
    store.claimQueued(task.id, Date.now(), "pisa/x");
    store.transition(task.id, "succeeded", { summary: "改好了", endedAt: Date.now() });
    const r = await pending;
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(parse<TaskJson>(r).summary).toBe("改好了");
  });

  test("--wait 任务失败返回 2", async () => {
    const submitted = parse<TaskJson>(await cli(...base("run", "会失败", "--json")));
    const pending = cli(...base("wait", submitted.id, "--timeout", "5", "--interval", "20", "--json"));
    const task = store.get(submitted.id)!;
    store.claimQueued(task.id, Date.now(), "pisa/y");
    store.transition(task.id, "failed", { error: "编译失败", endedAt: Date.now() });
    const r = await pending;
    expect(r.code).toBe(EXIT.component);
    expect(parse<TaskJson>(r).error).toBe("编译失败");
  });

  test("--wait 超时返回 2，任务仍在排队", async () => {
    const submitted = parse<TaskJson>(await cli(...base("run", "慢任务", "--json")));
    const r = await cli(...base("wait", submitted.id, "--timeout", "0", "--interval", "20", "--json"));
    expect(r.code).toBe(EXIT.component);
    expect(parse<{ timeout: boolean; status: string }>(r)).toMatchObject({ timeout: true, status: "queued" });
  });
});

describe("continue 与 retry", () => {
  test("continue 继承父任务分支与上下文", async () => {
    const parent = seed({
      status: "succeeded",
      branch: "pisa/parent",
      prUrl: "https://github.com/o/r/pull/7",
      summary: "第一轮完成",
    });
    const r = await cli(...base("continue", parent.id, "按评论再改", "--event-id", "c1", "--json"));
    expect(r.code).toBe(EXIT.ok);
    const body = parse<{ ticket: TaskJson }>(r);
    const again = parse<{ ticket: TaskJson }>(
      await cli(...base("continue", parent.id, "按评论再改", "--event-id", "c1", "--json")),
    );
    expect(again.ticket.id).toBe(body.ticket.id);
    const child = store.get(body.ticket.id)!;
    expect(child.id).not.toBe(parent.id);
    expect(child.repo).toBe("demo");
    expect(child.baseRef).toBe("pisa/parent");
    expect(child.context).toContain(parent.id);
    expect(child.context).toContain("上一轮请求：种子任务");
  });

  test("父任务没有分支时报错", async () => {
    const parent = seed();
    const r = await cli(...base("continue", parent.id, "x"));
    expect(r.code).toBe(EXIT.component);
    expect(r.err).toContain("没有可续跑的分支");
  });

  test("失败任务重试建出新任务", async () => {
    const failed = seed({ status: "failed", branch: "pisa/failed" });
    const r = await cli(...base("retry", failed.id, "--json"));
    expect(r.code).toBe(EXIT.ok);
    const body = parse<{ ticket: TaskJson; retriedFrom: string }>(r);
    expect(body.retriedFrom).toBe(failed.id);
    expect(store.get(body.ticket.id)!.baseRef).toBe("pisa/failed");
    expect(store.get(failed.id)!.status).toBe("failed");
  });
});

describe("查询与操作", () => {
  test("status 输出看板、守护进程与执行器", async () => {
    seed({ prompt: "排队中" });
    const text = await cli(...base("status"));
    expect(text.code).toBe(EXIT.ok);
    expect(text.out).toContain("排队（1）");
    expect(text.out).toContain("working/queued（等空闲槽位）");
    expect(text.out).toContain("守护进程：未运行");
    expect(text.out).toContain("执行器：运行中（0/1）");

    store.beat();
    const body = parse<StateJson>(await cli(...base("status", "--json")));
    expect(body.daemon.alive).toBe(true);
    expect(body.total).toBe(1);
    expect(body.queued[0]!.prompt).toBe("排队中");
    expect(body.queued[0]!.status).toBe("queued");
    expect(body.queued[0]!.stage).toBe("working/queued");
    expect(body.queued[0]!.stageLabel).toBe("等空闲槽位");
  });

  test("show 与 logs", async () => {
    const task = seed();
    const shown = await cli(...base("show", task.id, "--json"));
    expect(shown.code).toBe(EXIT.ok);
    expect(parse<TaskJson>(shown).id).toBe(task.id);
    expect(parse<TaskJson>(shown).stage).toBe("working/queued");

    const human = await cli(...base("show", task.id));
    expect(human.out).toContain("阶段：working/queued（等空闲槽位）");

    mkdirSync(join(stateDir, "logs"), { recursive: true });
    writeFileSync(join(stateDir, "logs", `${task.id}.log`), "a\nb\nc\n");
    const logs = await cli(...base("logs", task.id, "--tail", "2"));
    expect(logs.code).toBe(EXIT.ok);
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
  });

  test("stop 排队任务", async () => {
    const queued = seed();
    expect((await cli(...base("stop", queued.id))).code).toBe(EXIT.ok);
    expect(store.get(queued.id)!.status).toBe("cancelled");
  });

  test("pause 与 resume 落库", async () => {
    expect((await cli(...base("pause", "--json"))).code).toBe(EXIT.ok);
    expect(store.getMeta("executor.paused")).toBe("1");
    expect((await cli(...base("resume", "--json"))).code).toBe(EXIT.ok);
    expect(store.getMeta("executor.paused")).toBe("0");
  });

  test("repos 列出别名与授权状态", async () => {
    const body = parse<Array<Record<string, unknown>>>(await cli(...base("repos", "--json")));
    expect(body).toEqual([{ alias: "demo", path: repo, remote: null, baseBranch: "main", allowed: true }]);
  });

  test("help 列出四档退出码", async () => {
    const r = await cli("help");
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("1 需重启");
    expect(r.out).toContain("3 待配置");
  });
});

describe("退出码 1 需重启", () => {
  test("merge 合并进主干后返回 1", async () => {
    const submitted = parse<TaskJson>(await cli(...base("run", "新建 out.txt", "--json")));
    expect(await router.drainOnce()).toBe(true);
    expect(store.get(submitted.id)!.status).toBe("succeeded");

    const merged = await cli(...base("merge", submitted.id, "--json"));
    expect(merged.code).toBe(EXIT.restart);
    const body = parse<{ restartRequired: boolean; status: string }>(merged);
    expect(body.restartRequired).toBe(true);
    expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).toBe(0);
  });

  test("rewind 带 --yes 才真撤销", async () => {
    const task = seed({ status: "succeeded" });
    const preview = await cli(...base("rewind", task.id, "--json"));
    expect(preview.code).toBe(EXIT.ok);
    expect(store.get(task.id)!.status).toBe("succeeded");

    const done = await cli(...base("rewind", task.id, "--yes", "--json"));
    expect(done.code).toBe(EXIT.ok);
    expect(store.get(task.id)!.status).toBe("rewound");
  });
});
