import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { loadConfig } from "../src/config";
import { newTaskId } from "../src/ids";
import type { Task } from "../src/types";
import { startHarness, type Harness } from "./api-harness";

let h: Harness | undefined;

afterEach(() => {
  h?.stop();
  h = undefined;
});

interface Result {
  code: number;
  out: string;
  err: string;
}

async function cliAt(configPath: string, ...argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...argv, "--config", configPath], { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function cli(...argv: string[]): Promise<Result> {
  return cliAt(h!.cfgPath, ...argv);
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

/** 输出来自本进程 CLI，形状由接口类型约束；解析失败应让测试直接报错 */
function parse<T>(result: Result): T {
  return JSON.parse(result.out) as T;
}

function seed(over: Partial<Task> = {}): Task {
  const task: Task = {
    id: newTaskId(),
    source: `seed:${newTaskId()}`,
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
  h!.store.insertTask(task);
  return task;
}

function rewriteConfig(patch: Record<string, unknown>): void {
  const cfg = JSON.parse(readFileSync(h!.cfgPath, "utf8")) as Record<string, unknown>;
  writeFileSync(h!.cfgPath, JSON.stringify({ ...cfg, ...patch }));
}

describe("config 路径锚定", () => {
  test("stateDir 与仓库相对路径以配置文件目录为基准", () => {
    h = startHarness();
    const cfg = loadConfig(h.cfgPath);
    expect(cfg.stateDir).toBe(h.stateDir);
    expect(cfg.repos[0]!.path).toBe(h.repo);
  });
});

describe("pisa run", () => {
  test("提交任务并返回任务号", async () => {
    h = startHarness();
    const r = await cli("run", "修一下 CI", "--requester", "u1", "--json");
    expect(r.code, r.err).toBe(0);
    const body = parse<TaskJson>(r);
    expect(body.status).toBe("queued");
    expect(body.repo).toBe("demo");
    expect(body.id).toMatch(/^t_\d{8}_[0-9a-f]{6}$/);
    expect(body.message).toBe("已入队");

    const task = h.store.get(body.id)!;
    expect(task.prompt).toBe("修一下 CI");
    expect(task.channel).toBe("api");
    expect(task.requester).toBe("u1");
  });

  test("守护进程不在时给出警告但仍入队", async () => {
    h = startHarness({ beat: false });
    const r = await cli("run", "修 CI");
    expect(r.code).toBe(0);
    expect(r.out).toContain("已入队");
    expect(r.err).toContain("没有检测到运行中的 pisa 守护进程");
  });

  test("--event-id 重复提交返回同一个任务", async () => {
    h = startHarness();
    const first = parse<TaskJson>(await cli("run", "修 CI", "--event-id", "e1", "--json"));
    const second = parse<TaskJson>(await cli("run", "修 CI", "--event-id", "e1", "--json"));
    expect(second.id).toBe(first.id);
    expect(second.message).toContain("事件已存在");
    expect(h.store.listTasks().length).toBe(1);
  });

  test("未知仓库与未授权仓库都是待配置退出码 3", async () => {
    h = startHarness();
    expect((await cli("run", "x", "--repo", "nope")).code).toBe(3);

    h.stop();
    h = startHarness({ cfg: (cfg) => { cfg.whitelist.repos = ["other"]; } });
    const denied = await cli("run", "x", "--repo", "demo");
    expect(denied.code).toBe(3);
    expect(denied.err).toContain("不在 whitelist.repos");
  });

  test("缺少需求正文是用法错误 2", async () => {
    h = startHarness();
    expect((await cli("run")).code).toBe(2);
  });

  test("--wait 在任务成功后输出摘要", async () => {
    h = startHarness();
    const created = parse<TaskJson>(await cli("run", "修 CI", "--event-id", "e2", "--json"));
    h.store.claimQueued(created.id, Date.now(), "pisa/x");
    h.store.transition(created.id, "succeeded", { summary: "改好了", endedAt: Date.now() });
    // 复用同一事件键：run --wait 直接等待已存在的任务，避免测试里猜轮询时机
    const r = await cli("run", "修 CI", "--event-id", "e2", "--wait", "--json");
    expect(r.code, r.err).toBe(0);
    expect(parse<TaskJson>(r).summary).toBe("改好了");
  });

  test("--wait 在任务失败时返回 2", async () => {
    h = startHarness();
    const created = parse<TaskJson>(await cli("run", "会失败", "--event-id", "e3", "--json"));
    h.store.claimQueued(created.id, Date.now(), "pisa/y");
    h.store.transition(created.id, "failed", { error: "编译失败", endedAt: Date.now() });
    const r = await cli("run", "会失败", "--event-id", "e3", "--wait", "--json");
    expect(r.code).toBe(2);
    expect(parse<TaskJson>(r).error).toBe("编译失败");
  });

  test("--wait 超时返回 2，任务仍在排队", async () => {
    h = startHarness();
    const r = await cli("run", "慢任务", "--wait", "--timeout", "0", "--interval", "20", "--json");
    expect(r.code).toBe(2);
    expect(parse<{ timeout: boolean; status: string }>(r)).toMatchObject({ timeout: true, status: "queued" });
  });
});

describe("pisa continue", () => {
  test("继承父任务分支与上下文", async () => {
    h = startHarness();
    const parent = seed({
      status: "succeeded",
      branch: "pisa/parent",
      prUrl: "https://github.com/o/r/pull/7",
      summary: "第一轮完成",
    });
    const r = await cli("continue", parent.id, "按评论再改", "--json");
    expect(r.code, r.err).toBe(0);
    const body = parse<TaskJson>(r);
    expect(body.id).not.toBe(parent.id);

    const child = h.store.get(body.id)!;
    expect(child.repo).toBe("demo");
    expect(child.baseRef).toBe("pisa/parent");
    expect(child.prUrl).toBe(parent.prUrl);
    expect(child.context).toContain(parent.id);
    expect(child.context).toContain("上一轮请求：种子任务");
  });

  test("父任务不存在或没有分支时报错", async () => {
    h = startHarness();
    expect((await cli("continue", "t_missing", "x")).code).toBe(2);
    const parent = seed();
    const r = await cli("continue", parent.id, "x");
    expect(r.code).toBe(2);
    expect(r.err).toContain("没有可续跑的分支");
  });
});

describe("查询", () => {
  test("status 输出看板，心跳过期时退出码 1", async () => {
    h = startHarness({ beat: false });
    seed({ prompt: "排队中" });
    const text = await cli("status");
    expect(text.code).toBe(1);
    expect(text.out).toContain("排队（1）");
    expect(text.out).toContain("守护进程：未运行");

    h.store.beat();
    const body = parse<{ daemon: { alive: boolean }; total: number; queued: TaskJson[] }>(await cli("status", "--json"));
    expect(body.daemon.alive).toBe(true);
    expect(body.total).toBe(1);
    expect(body.queued[0]!.prompt).toBe("排队中");
    expect((await cli("status")).code).toBe(0);
  });

  test("show 与 logs", async () => {
    h = startHarness();
    const task = seed();
    const shown = await cli("show", task.id, "--json");
    expect(shown.code).toBe(0);
    expect(parse<TaskJson>(shown).id).toBe(task.id);
    expect((await cli("show", "t_missing", "--json")).code).toBe(2);

    mkdirSync(join(h.stateDir, "logs"), { recursive: true });
    writeFileSync(join(h.stateDir, "logs", `${task.id}.log`), "a\nb\nc\n");
    const logs = await cli("logs", task.id, "--tail", "2");
    expect(logs.code).toBe(0);
    expect(logs.out.trim().split("\n")).toEqual(["b", "c"]);
    expect((await cli("logs", "t_missing")).code).toBe(2);
  });

  test("list 按状态与 PR 过滤", async () => {
    h = startHarness();
    seed({ prompt: "queued one" });
    seed({ prompt: "done", status: "succeeded", prUrl: "https://github.com/o/r/pull/42" });
    seed({ prompt: "other pr", status: "succeeded", prUrl: "https://github.com/o/r/pull/43" });

    const queued = parse<TaskJson[]>(await cli("list", "--status", "queued", "--json"));
    expect(queued.map((t) => t.prompt)).toEqual(["queued one"]);

    const pr = parse<TaskJson[]>(await cli("list", "--pr", "42", "--json"));
    expect(pr.length).toBe(1);
    expect(pr[0]!.prompt).toBe("done");

    expect((await cli("list", "--status", "nope")).code).toBe(2);
  });

  test("wait 直接等待任务终态", async () => {
    h = startHarness();
    const task = seed();
    h.store.claimQueued(task.id, Date.now(), "pisa/x");
    h.store.transition(task.id, "succeeded", { summary: "已经好了", endedAt: Date.now() });
    const r = await cli("wait", task.id, "--json");
    expect(r.code).toBe(0);
    expect(parse<TaskJson>(r).summary).toBe("已经好了");
  });

  test("repos 列出别名与授权状态", async () => {
    h = startHarness();
    const body = parse<Array<Record<string, unknown>>>(await cli("repos", "--json"));
    expect(body).toEqual([
      { alias: "demo", path: h.repo, remote: null, baseBranch: "main", allowed: true },
    ]);
  });
});

describe("操作", () => {
  test("stop 排队任务与拒绝终态任务", async () => {
    h = startHarness();
    const queued = seed();
    expect((await cli("stop", queued.id)).code).toBe(0);
    expect(h.store.get(queued.id)!.status).toBe("cancelled");

    const done = seed({ status: "succeeded" });
    const r = await cli("stop", done.id);
    expect(r.code).toBe(2);
    expect(r.err).toContain("已结束");
    expect((await cli("stop", "t_missing")).code).toBe(2);
  });

  test("retry 只接受失败任务，重复执行返回同一新任务", async () => {
    h = startHarness();
    const failed = seed({ status: "failed", error: "炸了" });
    const first = parse<TaskJson>(await cli("retry", failed.id, "--json"));
    expect(first.id).not.toBe(failed.id);
    expect(first.message).toContain("已重试入队");
    const second = parse<TaskJson>(await cli("retry", failed.id, "--json"));
    expect(second.id).toBe(first.id);
    expect(h.store.get(first.id)!.prompt).toBe(failed.prompt);

    const done = seed({ status: "succeeded" });
    const rejected = await cli("retry", done.id);
    expect(rejected.code).toBe(2);
    expect(rejected.err).toContain("只有失败或已取消的任务可以重试");
  });

  test("merge 对未成功任务返回 2", async () => {
    h = startHarness();
    const queued = seed();
    const r = await cli("merge", queued.id);
    expect(r.code).toBe(2);
    expect(r.err).toContain("没有可合并的分支");
  });

  test("executor pause/resume 切换执行器状态", async () => {
    h = startHarness();
    const paused = await cli("executor", "pause");
    expect(paused.code).toBe(0);
    expect(paused.out).toContain("已暂停");
    expect(h.store.executorPaused()).toBe(true);

    const resumed = await cli("executor", "resume");
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain("已恢复");
    expect(h.store.executorPaused()).toBe(false);
    expect((await cli("executor", "boom")).code).toBe(2);
  });

  test("rewind 默认预览，--json 输出与接口一致", async () => {
    h = startHarness();
    const task = seed({ status: "succeeded", branch: "pisa/x" });
    const preview = parse<{ plan: { task: { id: string } }; results: unknown; rewound: boolean }>(
      await cli("rewind", task.id, "--json"),
    );
    expect(preview.plan.task.id).toBe(task.id);
    expect(preview.results).toBeNull();
    expect(preview.rewound).toBe(false);
    expect((await cli("rewind", "t_missing")).code).toBe(2);
  });
});

describe("退出码", () => {
  test("api.json 缺失或令牌失效返回 1", async () => {
    h = startHarness();
    const apiPath = join(h.stateDir, "api.json");
    rmSync(apiPath);
    const missing = await cli("status");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("api.json");

    writeFileSync(apiPath, JSON.stringify({ port: h.port, token: "wrong-token" }));
    const denied = await cli("status");
    expect(denied.code).toBe(1);
    expect(denied.err).toContain("unauthorized");
  });

  test("管理接口关闭与配置缺失返回 3", async () => {
    h = startHarness();
    rewriteConfig({ api: { enabled: false } });
    const disabled = await cli("status");
    expect(disabled.code).toBe(3);
    expect(disabled.err).toContain("管理接口未启用");

    const missing = await cliAt(join(h.root, "nope.json"), "status");
    expect(missing.code).toBe(3);
    expect(missing.err).toContain("找不到配置文件");
  });

  test("未知命令与未知选项返回 2", async () => {
    h = startHarness();
    expect((await cli("nope")).code).toBe(2);
    expect((await cli("run", "x", "--bogus")).code).toBe(2);
  });
});
