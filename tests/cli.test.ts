import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEB, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { startWebServer, type WebServer } from "../src/web";
import { ReplyBus } from "../src/channels/reply-bus";
import { API_CHAT_ID } from "../src/api";
import { runCli } from "../src/cli";
import type { ChannelAdapter, DeliveryReceipt, WorkerResult } from "../src/types";
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

const failWorker: WorkerRunner = {
  async run(): Promise<WorkerResult> {
    return { ok: false, summary: "", error: "adapter 挂了", exitCode: 1 };
  },
};

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-cli-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

const TOKEN_ENV = "PISA_TEST_TOKEN";
const TOKEN = "cli-token";

interface CliResult {
  code: number;
  out: string;
  err: string;
  json: () => unknown;
}

interface Fixture {
  cfg: Config;
  store: Store;
  router: Router;
  server: WebServer;
  configPath: string;
  repo: string;
  stateDir: string;
}

/** 起一套真实控制面：CLI 只通过 127.0.0.1 与它对话 */
function boot(worker: WorkerRunner = okWorker): Fixture {
  const repo = makeRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "pisa-cli-state-"));
  const store = new Store(":memory:");
  const cfg: Config = {
    trigger: "/pisa",
    dmWithoutTrigger: false,
    whitelist: { users: [], repos: ["demo"] },
    repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    web: { ...DEFAULT_WEB, enabled: false, tokenEnv: TOKEN_ENV, userId: "u1", chatId: "web" },
    stateDir,
  };
  const bus = new ReplyBus("web", new FakeChannel(), [API_CHAT_ID]);
  const router = new Router({ cfg, store, worker, deliverer: new GitDeliverer(cfg), channel: bus });
  const server = startWebServer({ cfg, store, router, bus }, { ...cfg.web!, port: 0 });
  const configPath = join(stateDir, "pisa.config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ ...cfg, web: { ...cfg.web, port: server.server.port } }, null, 2),
  );
  router.start(20);
  return { cfg, store, router, server, configPath, repo, stateDir };
}

async function tearDown(fx: Fixture): Promise<void> {
  await fx.router.stop(100);
  await fx.server.stop();
  fx.store.close();
  rmSync(fx.repo, { recursive: true, force: true });
  rmSync(fx.stateDir, { recursive: true, force: true });
}

async function cli(configPath: string, argv: string[]): Promise<CliResult> {
  let out = "";
  let err = "";
  const code = await runCli([...argv, "--config", configPath], {
    out: (t) => {
      out += `${t}\n`;
    },
    err: (t) => {
      err += `${t}\n`;
    },
  });
  return {
    code,
    out,
    err,
    json: () => JSON.parse(out),
  };
}

/** CLI 不发请求就能判定的用例（缺配置、缺 token），不需要控制面 */
describe("pisa CLI 待配置", () => {
  test("找不到配置文件退出 3", async () => {
    const res = await cli("/nonexistent/pisa.config.json", ["status"]);
    expect(res.code).toBe(3);
    expect(res.err).toContain("找不到配置文件");
  });

  test("缺 token 退出 3 并提示变量名", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-cli-cfg-"));
    const configPath = join(dir, "pisa.config.json");
    writeFileSync(configPath, JSON.stringify({ repos: [], web: { ...DEFAULT_WEB, port: 1, tokenEnv: "PISA_TEST_MISSING" } }));
    const saved = process.env.PISA_TEST_MISSING;
    delete process.env.PISA_TEST_MISSING;
    try {
      const res = await cli(configPath, ["status"]);
      expect(res.code).toBe(3);
      expect(res.err).toContain("PISA_TEST_MISSING");
    } finally {
      if (saved !== undefined) process.env.PISA_TEST_MISSING = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("未知命令与缺参数都是 3", async () => {
    const fx = boot();
    try {
      expect((await cli(fx.configPath, ["nope"])).code).toBe(3);
      expect((await cli(fx.configPath, ["show"])).code).toBe(3);
      expect((await cli(fx.configPath, ["run"])).code).toBe(3);
      expect((await cli(fx.configPath, ["list", "--status", "bogus"])).code).toBe(3);
      expect((await cli(fx.configPath, ["status", "--nope"])).code).toBe(3);
    } finally {
      await tearDown(fx);
    }
  });
});

describe("pisa CLI 与控制面", () => {
  let fx: Fixture;
  const savedToken = process.env[TOKEN_ENV];

  beforeEach(() => {
    process.env[TOKEN_ENV] = TOKEN;
    fx = boot();
  });

  afterEach(async () => {
    await tearDown(fx);
    if (savedToken === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = savedToken;
  });

  describe("状态", () => {
    test("status --json 输出接口快照并退出 0", async () => {
      const res = await cli(fx.configPath, ["status", "--json"]);
      expect(res.code).toBe(0);
      const body = res.json() as { ok: boolean; daemon: { alive: boolean }; executor: { paused: boolean }; text: string };
      expect(body.ok).toBe(true);
      expect(body.daemon.alive).toBe(true);
      expect(body.executor.paused).toBe(false);
      expect(body.text).toContain("汇总");
    });

    test("status 文本包含看板、守护进程与执行器", async () => {
      const res = await cli(fx.configPath, ["status"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("守护进程：运行中");
      expect(res.out).toContain("执行器：运行中");
    });

    test("执行器暂停后 status 退出 1，恢复后回到 0", async () => {
      expect((await cli(fx.configPath, ["executor", "pause"])).code).toBe(0);
      const paused = await cli(fx.configPath, ["status"]);
      expect(paused.code).toBe(1);
      expect(paused.out).toContain("执行器已暂停");
      expect((await cli(fx.configPath, ["executor", "resume"])).code).toBe(0);
      expect((await cli(fx.configPath, ["status"])).code).toBe(0);
    });

    test("executor --json 报当前执行器", async () => {
      const res = await cli(fx.configPath, ["executor", "--json"]);
      expect(res.code).toBe(0);
      expect(res.json()).toEqual({ paused: false, running: 0, limit: 1 });
    });

    test("repos --json 来自接口配置", async () => {
      const res = await cli(fx.configPath, ["repos", "--json"]);
      expect(res.code).toBe(0);
      const repos = res.json() as Array<{ alias: string; allowed: boolean }>;
      expect(repos[0]!.alias).toBe("demo");
      expect(repos[0]!.allowed).toBe(true);
    });

    test("token 不符退出 3", async () => {
      process.env[TOKEN_ENV] = "wrong";
      const res = await cli(fx.configPath, ["status"]);
      expect(res.code).toBe(3);
      expect(res.err).toContain("token 不匹配");
    });
  });

  describe("派活", () => {
    test("run --wait 成功退出 0，任务记为 api 入口", async () => {
      const res = await cli(fx.configPath, ["run", "修 login 跳转", "--wait", "--json"]);
      expect(res.code).toBe(0);
      const task = res.json() as { id: string; status: string };
      expect(task.status).toBe("succeeded");
      expect(fx.store.get(task.id)!.channel).toBe("api");
      expect(fx.store.get(task.id)!.prompt).toBe("修 login 跳转");
    });

    test("run 不带 --wait 只回任务号", async () => {
      const res = await cli(fx.configPath, ["run", "改个常量", "--json"]);
      expect(res.code).toBe(0);
      const task = res.json() as { id: string; status: string };
      expect(task.id).toBeTruthy();
      expect(fx.store.get(task.id)).not.toBeNull();
    });

    test("task 是 run 的别名", async () => {
      const res = await cli(fx.configPath, ["task", "再来一次", "--repo", "demo", "--json"]);
      expect(res.code).toBe(0);
      expect(fx.store.get((res.json() as { id: string }).id)!.repo).toBe("demo");
    });

    test("未知仓库退出 3", async () => {
      const res = await cli(fx.configPath, ["run", "随便", "--repo", "nope"]);
      expect(res.code).toBe(3);
      expect(res.err).toContain("仓库");
    });

    test("list / show / logs 可脚本化", async () => {
      const dispatched = await cli(fx.configPath, ["run", "看板任务", "--wait", "--json"]);
      const id = (dispatched.json() as { id: string }).id;

      const list = await cli(fx.configPath, ["list", "--status", "succeeded", "--json"]);
      expect(list.code).toBe(0);
      expect((list.json() as Array<{ id: string }>).map((t) => t.id)).toContain(id);

      const show = await cli(fx.configPath, ["show", id, "--json"]);
      expect(show.code).toBe(0);
      expect((show.json() as { task: { id: string } }).task.id).toBe(id);

      const logs = await cli(fx.configPath, ["logs", id, "--json"]);
      expect(logs.code).toBe(0);
      expect(Array.isArray(logs.json())).toBe(true);
    });

    test("show 不存在的任务退出 3", async () => {
      const res = await cli(fx.configPath, ["show", "t_missing"]);
      expect(res.code).toBe(3);
      expect(res.err).toContain("找不到任务");
    });

    test("wait 超时退出 1", async () => {
      await cli(fx.configPath, ["executor", "pause"]);
      const dispatched = await cli(fx.configPath, ["run", "先排队", "--json"]);
      const id = (dispatched.json() as { id: string }).id;
      const res = await cli(fx.configPath, ["wait", id, "--timeout", "1", "--interval", "20"]);
      expect(res.code).toBe(1);
      expect(res.err).toContain("等待超时");
      await cli(fx.configPath, ["cancel", id]);
    });
  });

  describe("动作", () => {
    test("cancel 排队任务退出 0，重复取消幂等，已完成任务退出 2", async () => {
      await cli(fx.configPath, ["executor", "pause"]);
      const dispatched = await cli(fx.configPath, ["run", "待取消", "--json"]);
      const id = (dispatched.json() as { id: string }).id;
      expect((await cli(fx.configPath, ["cancel", id])).code).toBe(0);
      expect(fx.store.get(id)!.status).toBe("cancelled");
      expect((await cli(fx.configPath, ["stop", id])).code).toBe(0);
      await cli(fx.configPath, ["executor", "resume"]);

      const done = await cli(fx.configPath, ["run", "会成功", "--wait", "--json"]);
      const doneId = (done.json() as { id: string }).id;
      expect((await cli(fx.configPath, ["cancel", doneId])).code).toBe(2);
      expect(fx.store.get(doneId)!.status).toBe("succeeded");
    });

    test("retry 失败任务生成新任务，非失败任务退出 2", async () => {
      const queued = await cli(fx.configPath, ["run", "会失败", "--json"]);
      const queuedId = (queued.json() as { id: string }).id;
      const res = await cli(fx.configPath, ["retry", queuedId]);
      expect(res.code).toBe(2);
      expect(fx.store.get(queuedId)!.status).not.toBe("failed");
    });

    test("merge --json 合并成功任务", async () => {
      const dispatched = await cli(fx.configPath, ["run", "新建 out.txt", "--wait", "--json"]);
      const id = (dispatched.json() as { id: string }).id;
      const supervised = process.env.PISA_SUPERVISED;
      delete process.env.PISA_SUPERVISED;
      try {
        const res = await cli(fx.configPath, ["merge", id, "--json"]);
        expect(res.code).toBe(0);
        expect((res.json() as { ok: boolean }).ok).toBe(true);
        expect(sh(["git", "-C", fx.repo, "cat-file", "-e", "main:out.txt"]).code).toBe(0);
      } finally {
        if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
      }
    });

    test("rewind 未结束的任务退出 2", async () => {
      await cli(fx.configPath, ["executor", "pause"]);
      const dispatched = await cli(fx.configPath, ["run", "还没跑", "--json"]);
      const id = (dispatched.json() as { id: string }).id;
      const res = await cli(fx.configPath, ["rewind", id, "--yes"]);
      expect(res.code).toBe(2);
      await cli(fx.configPath, ["cancel", id]);
      await cli(fx.configPath, ["executor", "resume"]);
    });

    test("rewind 不带 --yes 只出计划", async () => {
      const dispatched = await cli(fx.configPath, ["run", "先做", "--wait", "--json"]);
      const id = (dispatched.json() as { id: string }).id;
      const res = await cli(fx.configPath, ["rewind", id, "--json"]);
      expect(res.code).toBe(0);
      expect((res.json() as { message: string }).message).toContain(id);
      expect(fx.store.get(id)!.status).toBe("succeeded");
    });
  });

  describe("失败路径", () => {
    test("任务失败退出 2", async () => {
      const failing = boot(failWorker);
      try {
        const res = await cli(failing.configPath, ["run", "必失败", "--wait", "--json"]);
        expect(res.code).toBe(2);
        expect((res.json() as { status: string }).status).toBe("failed");
      } finally {
        await tearDown(failing);
      }
    });

    test("控制面不可达退出 1", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pisa-cli-down-"));
      const configPath = join(dir, "pisa.config.json");
      writeFileSync(configPath, JSON.stringify({ ...fx.cfg, web: { ...fx.cfg.web, port: 1 } }));
      try {
        const res = await cli(configPath, ["status"]);
        expect(res.code).toBe(1);
        expect(res.err).toContain("控制面不可达");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
