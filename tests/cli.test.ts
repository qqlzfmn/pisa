import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { loadConfig } from "../src/config";
import { Store } from "../src/store";
import { sh } from "../src/git";
import { newTaskId } from "../src/ids";
import type { Task } from "../src/types";

let root: string;
let repo: string;
let stateDir: string;
let cfgPath: string;

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
      whitelist: { users: [], repos: ["demo"] },
      stateDir: ".pisa",
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
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

/** 输出来自本进程 CLI，形状由上面的接口约束；解析失败应让测试直接报错 */
function parse<T>(result: Result): T {
  return JSON.parse(result.out) as T;
}

function base(...argv: string[]): string[] {
  return [...argv, "--config", cfgPath];
}

function seed(over: Partial<Task> = {}): Task {
  const store = new Store(join(stateDir, "pisa.db"));
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
  store.close();
  return task;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pisa-cli-"));
  repo = makeRepo();
  stateDir = join(root, ".pisa");
  cfgPath = join(root, "pisa.config.json");
  writeConfig();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("config 路径锚定", () => {
  test("stateDir 与仓库相对路径以配置文件目录为基准", () => {
    const cfg = loadConfig(cfgPath);
    expect(cfg.stateDir).toBe(stateDir);
    expect(cfg.repos[0]!.path).toBe(repo);
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

    const store = new Store(join(stateDir, "pisa.db"));
    const task = store.get(body.id)!;
    expect(task.prompt).toBe("修一下 CI");
    expect(task.channel).toBe("cli");
    expect(task.requester).toBe(process.env.USER ?? "local");
    store.close();
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

    const store = new Store(join(stateDir, "pisa.db"));
    expect(store.listTasks().length).toBe(1);
    store.close();
  });

  test("--event-id 重投不同正文按编辑处理，排队任务换成最新需求", async () => {
    const first = parse<TaskJson>(await cli(...base("task", "修 CI", "--event-id", "e2", "--json")));
    const edited = parse<TaskJson>(await cli(...base("task", "修 CI 并补测试", "--event-id", "e2", "--json")));
    expect(edited.id).toBe(first.id);
    expect(edited.message).toContain("需求已按最新版本更新");

    const store = new Store(join(stateDir, "pisa.db"));
    expect(store.listTasks()[0]!.prompt).toBe("修 CI 并补测试");
    store.close();
  });

  test("未知仓库别名与未授权仓库都以用法错误退出", async () => {
    expect((await cli(...base("task", "x", "--repo", "nope"))).code).toBe(2);
    writeConfig({ whitelist: { users: [], repos: ["other"] } });
    const denied = await cli(...base("task", "x", "--repo", "demo"));
    expect(denied.code).toBe(2);
    expect(denied.err).toContain("不在 whitelist.repos");
  });

  test("仓库路径不是 git 仓库时拒绝", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    writeConfig({ repos: [{ alias: "demo", path: plain }] });
    const r = await cli(...base("task", "x"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("不是 git 仓库");
  });

  test("缺少需求正文", async () => {
    expect((await cli(...base("task"))).code).toBe(2);
  });

  test("--wait 在任务成功后输出摘要", async () => {
    const pending = cli(...base("task", "修 CI", "--wait", "--timeout", "3", "--interval", "20", "--json"));
    // dispatch 在第一个 await 前已完成入队，此处无需等待
    const store = new Store(join(stateDir, "pisa.db"));
    const task = store.nextQueued()!;
    store.claimQueued(task.id, Date.now(), "pisa/x");
    store.transition(task.id, "succeeded", { summary: "改好了", endedAt: Date.now() });
    store.close();
    const r = await pending;
    expect(r.code, r.err).toBe(0);
    expect(parse<TaskJson>(r).summary).toBe("改好了");
  });

  test("--wait 在任务失败时返回 1", async () => {
    const pending = cli(...base("task", "会失败", "--wait", "--timeout", "3", "--interval", "20", "--json"));
    const store = new Store(join(stateDir, "pisa.db"));
    const task = store.nextQueued()!;
    store.claimQueued(task.id, Date.now(), "pisa/y");
    store.transition(task.id, "failed", { error: "编译失败", endedAt: Date.now() });
    store.close();
    const r = await pending;
    expect(r.code).toBe(1);
    expect(parse<TaskJson>(r).error).toBe("编译失败");
  });

  test("--wait 超时返回 5，任务仍在排队", async () => {
    const r = await cli(...base("task", "慢任务", "--wait", "--timeout", "0", "--interval", "20", "--json"));
    expect(r.code).toBe(5);
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

    const store = new Store(join(stateDir, "pisa.db"));
    const child = store.get(body.id)!;
    expect(child.repo).toBe("demo");
    expect(child.baseRef).toBe("pisa/parent");
    expect(child.prUrl).toBe(parent.prUrl);
    expect(child.context).toContain(parent.id);
    expect(child.context).toContain("上一轮请求：种子任务");
    store.close();
  });

  test("父任务不存在或没有分支时报错", async () => {
    expect((await cli(...base("continue", "t_missing", "x"))).code).toBe(3);
    const parent = seed();
    const r = await cli(...base("continue", parent.id, "x"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("没有可续跑的分支");
  });
});

describe("查询与操作", () => {
  test("status 输出看板与守护进程状态", async () => {
    seed({ prompt: "排队中" });
    const text = await cli(...base("status"));
    expect(text.code).toBe(0);
    expect(text.out).toContain("排队（1）");
    expect(text.out).toContain("守护进程：未运行");

    const store = new Store(join(stateDir, "pisa.db"));
    store.beat();
    store.close();
    const body = parse<{ daemon: { alive: boolean }; total: number; queued: TaskJson[] }>(await cli(...base("status", "--json")));
    expect(body.daemon.alive).toBe(true);
    expect(body.total).toBe(1);
    expect(body.queued[0]!.prompt).toBe("排队中");
  });

  test("show 与 logs", async () => {
    const task = seed();
    const shown = await cli(...base("show", task.id, "--json"));
    expect(shown.code).toBe(0);
    expect(parse<TaskJson>(shown).id).toBe(task.id);

    expect((await cli(...base("show", "t_missing"))).code).toBe(3);

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

    expect((await cli(...base("list", "--status", "nope"))).code).toBe(2);
  });

  test("cancel 排队任务与拒绝终态任务", async () => {
    const queued = seed();
    expect((await cli(...base("cancel", queued.id))).code).toBe(0);
    let store = new Store(join(stateDir, "pisa.db"));
    expect(store.get(queued.id)!.status).toBe("cancelled");
    store.close();

    const done = seed({ status: "succeeded" });
    const r = await cli(...base("cancel", done.id));
    expect(r.code).toBe(4);
    expect((await cli(...base("cancel", "t_missing"))).code).toBe(3);
  });

  test("repos 列出别名与授权状态", async () => {
    const body = parse<Array<Record<string, unknown>>>(await cli(...base("repos", "--json")));
    expect(body).toEqual([{ alias: "demo", path: repo, remote: null, baseBranch: "main", allowed: true }]);
  });

  test("未知命令与未知选项", async () => {
    expect((await cli(...base("nope"))).code).toBe(2);
    expect((await cli(...base("task", "x", "--bogus"))).code).toBe(2);
  });
});
