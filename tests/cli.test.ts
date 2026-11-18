import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, runCli } from "../src/cli";
import { DEFAULT_WEB, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { ReplyBus, createWebApp } from "../src/web";
import { managementTokenPath, writeManagementToken } from "../src/mgmt";
import type { ChannelAdapter, DeliveryReceipt, Task, TaskStatus, WorkerResult } from "../src/types";
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

function makeRepo(root: string): string {
  const dir = join(root, "repo");
  mkdirSync(dir);
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

interface Result {
  code: number;
  out: string;
  err: string;
}

interface TaskJson {
  id: string;
  status: TaskStatus;
  prompt: string;
  repo: string;
  branch: string | null;
  summary: string | null;
  error: string | null;
}

interface StateResponse {
  ok: boolean;
  daemon: { alive: boolean; ageMs: number | null };
  executor: { paused: boolean; active: number; concurrency: number };
  counts: Record<TaskStatus, number>;
  total: number;
  finished: Array<{ id: string }>;
}

interface SubmitResponse {
  ok: boolean;
  taskId: string;
  task: TaskJson;
  message: string;
}

describe("pisa CLI", () => {
  let root: string;
  let repo: string;
  let stateDir: string;
  let cfgPath: string;
  let cfg: Config;
  let store: Store;
  let router: Router;
  let server: Server<unknown>;

  const TOKEN = "cli-token";

  function writeConfig(port: number, over: Record<string, unknown> = {}): void {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
        whitelist: { users: ["u1"], repos: ["demo"] },
        stateDir,
        worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
        web: { ...DEFAULT_WEB, enabled: true, port, userId: "u1", chatId: "web" },
        ...over,
      }),
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pisa-cli-"));
    stateDir = join(root, "state");
    cfgPath = join(root, "pisa.config.json");
    repo = makeRepo(root);
    delete process.env.PISA_WEB_TOKEN;

    store = new Store(join(stateDir, "pisa.db"));
    store.beat(Date.now());
    cfg = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: ["u1"], repos: ["demo"] },
      repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      web: { ...DEFAULT_WEB, enabled: true, port: 0, userId: "u1", chatId: "web" },
      stateDir,
    };
    const bus = new ReplyBus("web", new FakeChannel());
    router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel: bus });
    const app = createWebApp({ cfg, store, router, bus, token: TOKEN });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app });
    writeManagementToken(stateDir, TOKEN);
    writeConfig(server.port!);
  });

  afterEach(async () => {
    await server.stop(true);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function cli(...argv: string[]): Promise<Result> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([...argv, "--config", cfgPath], { out: (t) => out.push(t), err: (t) => err.push(t) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  /** 输出来自真实的 HTTP JSON；解析失败应让测试直接报错 */
  function parse<T>(result: Result): T {
    return JSON.parse(result.out) as T;
  }

  function seed(id = "t_cli_seed"): Task {
    const task: Task = {
      id,
      source: "seed",
      channel: "cli",
      chatId: "web",
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
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      cancelRequested: false,
    };
    store.insertTask(task);
    return task;
  }

  /** insertTask 不写结束时间：走完状态机才有终态字段 */
  function finish(id: string, to: TaskStatus, patch: Partial<Task> = {}): void {
    store.claimQueued(id, Date.now(), `pisa/${id}`);
    store.transition(id, to, { endedAt: Date.now(), ...patch });
  }

  test("status --json 返回快照，文本包含执行器", async () => {
    seed();
    const json = await cli("status", "--json");
    expect(json.code).toBe(EXIT.ok);
    const state = parse<StateResponse>(json);
    expect(state.daemon.alive).toBe(true);
    expect(state.counts.queued).toBe(1);
    expect(state.total).toBe(1);
    expect(state.executor.paused).toBe(false);

    const text = await cli("status");
    expect(text.code).toBe(EXIT.ok);
    expect(text.out).toContain("执行器");
  });

  test("token 文件只有本人可读", () => {
    expect(statSync(managementTokenPath(stateDir)).mode & 0o777).toBe(0o600);
  });

  test("run 入队后 wait 到成功", async () => {
    const run = await cli("run", "整理", "README", "--repo", "demo", "--json");
    expect(run.code).toBe(EXIT.ok);
    const created = parse<SubmitResponse>(run);
    expect(created.task.status).toBe("queued");
    expect(store.get(created.taskId)?.prompt).toBe("整理 README");

    expect(await router.drainOnce()).toBe(true);
    const wait = await cli("wait", created.taskId, "--json");
    expect(wait.code).toBe(EXIT.ok);
    expect(parse<TaskJson>(wait).status).toBe("succeeded");
    expect(store.get(created.taskId)?.summary).toBe("改了 out.txt");
  });

  test("run --event-id 重投返回同一个任务", async () => {
    const first = parse<SubmitResponse>(await cli("run", "同一件事", "--event-id", "ci:7", "--json"));
    const second = parse<SubmitResponse>(await cli("run", "同一件事", "--event-id", "ci:7", "--json"));
    expect(second.taskId).toBe(first.taskId);
  });

  test("wait 失败任务退出 2，超时也退出 2", async () => {
    const task = seed("t_cli_fail");
    finish(task.id, "failed", { error: "炸了" });
    const failed = await cli("wait", task.id, "--json");
    expect(failed.code).toBe(EXIT.fault);
    expect(parse<TaskJson>(failed).error).toBe("炸了");

    const queued = seed("t_cli_queued");
    const timeout = await cli("wait", queued.id, "--timeout", "1", "--interval", "1");
    expect(timeout.code).toBe(EXIT.fault);
    expect(timeout.err).toContain("等待超时");
  });

  test("show 与 logs 读详情，缺失任务退出 2", async () => {
    const task = seed();
    const show = await cli("show", task.id);
    expect(show.code).toBe(EXIT.ok);
    expect(show.out).toContain("种子任务");

    const logs = await cli("logs", task.id, "--json");
    expect(logs.code).toBe(EXIT.ok);
    expect(Array.isArray(parse<{ logTail: string[] }>(logs).logTail)).toBe(true);

    expect((await cli("show", "t_missing")).code).toBe(EXIT.fault);
  });

  test("list 过滤，状态拼错退出 2", async () => {
    seed();
    const list = await cli("list", "--status", "queued", "--json");
    expect(list.code).toBe(EXIT.ok);
    expect(parse<{ tickets: TaskJson[] }>(list).tickets).toHaveLength(1);
    expect((await cli("list", "--status", "nope")).code).toBe(EXIT.fault);
  });

  test("stop 取消排队任务，终态任务退出 2", async () => {
    const task = seed();
    expect((await cli("stop", task.id)).code).toBe(EXIT.ok);
    expect(store.get(task.id)!.status).toBe("cancelled");

    seed("t_cli_done");
    finish("t_cli_done", "succeeded");
    expect((await cli("stop", "t_cli_done")).code).toBe(EXIT.fault);
  });

  test("retry 新建同需求任务，运行中退出 2", async () => {
    const task = seed();
    finish(task.id, "failed", { error: "炸了" });
    const retry = await cli("retry", task.id, "--json");
    expect(retry.code).toBe(EXIT.ok);
    const created = parse<SubmitResponse>(retry);
    expect(created.taskId).not.toBe(task.id);
    expect(store.get(created.taskId)?.prompt).toBe("种子任务");

    store.insertTask({ ...task, id: "t_cli_running" });
    expect((await cli("retry", "t_cli_running")).code).toBe(EXIT.fault);
  });

  test("pause 与 pause --resume 改变执行器状态", async () => {
    expect((await cli("pause")).code).toBe(EXIT.ok);
    expect(parse<StateResponse>(await cli("status", "--json")).executor.paused).toBe(true);
    expect((await cli("pause", "--resume")).code).toBe(EXIT.ok);
    expect(parse<StateResponse>(await cli("status", "--json")).executor.paused).toBe(false);
  });

  test("merge 需要 --confirm，非看护模式退出 1", async () => {
    const supervised = process.env.PISA_SUPERVISED;
    delete process.env.PISA_SUPERVISED;
    try {
      const created = parse<SubmitResponse>(await cli("run", "新建 out.txt", "--json"));
      expect(await router.drainOnce()).toBe(true);
      expect((await cli("merge", created.taskId)).code).toBe(EXIT.fault);
      const merged = await cli("merge", created.taskId, "--confirm");
      expect(merged.code).toBe(EXIT.restart);
      expect(merged.out).toContain("重启");
    } finally {
      if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
    }
  });

  test("rewind 无 --yes 只预览", async () => {
    const task = seed();
    finish(task.id, "succeeded");
    const preview = await cli("rewind", task.id, "--json");
    expect(preview.code).toBe(EXIT.ok);
    expect(parse<{ applied: boolean }>(preview).applied).toBe(false);
  });

  test("待配置：缺配置、未启用管理接口、token 不对都退出 3", async () => {
    const errors: string[] = [];
    const missing = await runCli(["status", "--config", join(root, "nope.json")], {
      out: () => {},
      err: (t) => errors.push(t),
    });
    expect(missing).toBe(EXIT.unconfigured);
    expect(errors.join("\n")).toContain("读不到配置");

    writeConfig(server.port!, { web: { ...DEFAULT_WEB, enabled: false, port: server.port!, userId: "u1", chatId: "web" } });
    const disabled = await cli("status");
    expect(disabled.code).toBe(EXIT.unconfigured);
    expect(disabled.err).toContain("未启用");

    writeConfig(server.port!);
    process.env.PISA_WEB_TOKEN = "wrong";
    const wrong = await cli("status");
    delete process.env.PISA_WEB_TOKEN;
    expect(wrong.code).toBe(EXIT.unconfigured);
  });

  test("未知命令与未知参数退出 2，help 退出 0", async () => {
    expect((await cli("help")).code).toBe(EXIT.ok);
    expect((await cli("nope")).code).toBe(EXIT.fault);
    expect((await cli("status", "--bogus")).code).toBe(EXIT.fault);
    expect((await cli("run")).code).toBe(EXIT.fault);
  });
});
