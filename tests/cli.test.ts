import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, runCli, type CliDeps, type FetchLike } from "../src/cli";
import { createMgmtHandler } from "../src/mgmt";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import type { Config } from "../src/config";
import type { ChannelAdapter } from "../src/types";
import type { WorkerRunner } from "../src/worker";

const STATE = {
  paused: false,
  counts: { queued: 1, running: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0, rewound: 0 },
  running: [],
  queued: [
    {
      id: "t_1",
      repo: "demo",
      prompt: "修登录",
      status: "queued",
      createdAt: 0,
      startedAt: null,
      endedAt: null,
    },
  ],
  finished: [],
};

interface Captured {
  code: number;
  out: string[];
  err: string[];
}

async function run(argv: string[], deps: Partial<CliDeps> = {}): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    target: () => ({ url: "http://127.0.0.1:8800", token: "T" }),
    fetchImpl: async () => new Response("{}", { status: 200 }),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    now: () => 0,
    ...deps,
  });
  return { code, out, err };
}

function responder(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

describe("pisa CLI", () => {
  test("status 文本：退出码 0，看板来自接口", async () => {
    const { fetchImpl, calls } = responder(() => Response.json(STATE));
    const r = await run(["status"], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(r.out.join("\n")).toContain("排队（1）");
    expect(r.out.join("\n")).toContain("t_1");
    expect(calls[0]?.url).toBe("http://127.0.0.1:8800/state");
    expect((calls[0]?.init?.headers as Record<string, string>)["x-pisa-token"]).toBe("T");
  });

  test("--json 输出单行原始数据", async () => {
    const { fetchImpl } = responder(() => Response.json(STATE));
    const r = await run(["status", "--json"], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toEqual([JSON.stringify(STATE)]);
  });

  test("缺 token 退出码 3，且不发请求", async () => {
    let called = false;
    const r = await run(["status"], {
      target: () => ({ url: "http://127.0.0.1:8800", token: undefined }),
      fetchImpl: async () => {
        called = true;
        return Response.json(STATE);
      },
    });
    expect(r.code).toBe(EXIT.CONFIG);
    expect(called).toBe(false);
    expect(r.err.join("\n")).toContain("PISA_MGMT_TOKEN");
  });

  test("接口 403 退出码 3（越权或 token 不匹配）", async () => {
    const { fetchImpl } = responder(() => Response.json({ error: "token 不正确" }, { status: 403 }));
    const r = await run(["status"], { fetchImpl });
    expect(r.code).toBe(EXIT.CONFIG);
    expect(r.err.join("\n")).toContain("token 不正确");
  });

  test("连不上或 5xx 退出码 2", async () => {
    const down = await run(["status"], {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(down.code).toBe(EXIT.ERROR);

    const broken = responder(() => Response.json({ error: "boom" }, { status: 500 }));
    expect((await run(["status"], { fetchImpl: broken.fetchImpl })).code).toBe(EXIT.ERROR);
  });

  test("run 提交任务并回显任务号", async () => {
    const { fetchImpl, calls } = responder(() =>
      Response.json({ ticket: { id: "t_9", repo: "demo", status: "queued" } }, { status: 201 }),
    );
    const r = await run(["run", "修复", "登录", "--repo", "demo"], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(r.out.join("\n")).toContain("已接单 · t_9");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ prompt: "修复 登录", repo: "demo" });
    expect(calls[0]?.init?.method).toBe("POST");
  });

  test("run 没有正文退出码 2，不发请求", async () => {
    const { fetchImpl, calls } = responder(() => Response.json({}));
    const r = await run(["run", "--repo", "demo"], { fetchImpl });
    expect(r.code).toBe(EXIT.ERROR);
    expect(calls.length).toBe(0);
  });

  test("run 被拒（400）退出码 2", async () => {
    const { fetchImpl } = responder(() => Response.json({ error: "仓库未配置：x" }, { status: 400 }));
    const r = await run(["run", "做点事", "--repo", "x"], { fetchImpl });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err.join("\n")).toContain("仓库未配置");
  });

  test("logs 输出条目；空日志给占位", async () => {
    const entries = [{ ts: "2026-01-01T00:00:00.000Z", stage: "start", msg: "开始" }];
    const one = responder(() => Response.json({ entries }));
    const r = await run(["logs", "t_1"], { fetchImpl: one.fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toEqual(["2026-01-01T00:00:00.000Z start 开始"]);

    const empty = responder(() => Response.json({ entries: [] }));
    const e = await run(["logs", "t_1"], { fetchImpl: empty.fetchImpl });
    expect(e.out).toEqual(["(无日志)"]);
  });

  test("merge 需要重启时退出码 1", async () => {
    const { fetchImpl } = responder(() =>
      Response.json({ ok: true, text: "已合并 · t_1", needsRestart: true }),
    );
    const r = await run(["merge", "t_1"], { fetchImpl });
    expect(r.code).toBe(EXIT.RESTART);
    expect(r.out).toEqual(["已合并 · t_1"]);
  });

  test("merge 失败退出码 2", async () => {
    const { fetchImpl } = responder(() => Response.json({ error: "任务 t_1 没有可合并的分支（failed）。" }, { status: 409 }));
    const r = await run(["merge", "t_1"], { fetchImpl });
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err.join("\n")).toContain("没有可合并的分支");
  });

  test("rewind --yes 传递确认标志", async () => {
    const { fetchImpl, calls } = responder(() => Response.json({ ok: true, text: "已撤销" }));
    const r = await run(["rewind", "t_1", "--yes"], { fetchImpl });
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ yes: true });
  });

  test("未知命令与空参数退出码 2，help 为 0", async () => {
    expect((await run(["nope"])).code).toBe(EXIT.ERROR);
    expect((await run([])).code).toBe(EXIT.ERROR);
    expect((await run(["help"])).code).toBe(EXIT.OK);
  });
});

describe("pisa CLI × 真实管理服务", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  const noopWorker: WorkerRunner = {
    async run() {
      return { ok: true, summary: "", exitCode: 0 };
    },
  };

  class NullChannel implements ChannelAdapter {
    name = "null";
    async start(): Promise<void> {}
    async send(): Promise<{ messageId: string }> {
      return { messageId: "1" };
    }
    async stop(): Promise<void> {}
  }

  function startServer(): { url: string; token: string } {
    const stateDir = mkdtempSync(join(tmpdir(), "pisa-cli-state-"));
    const store = new Store(join(stateDir, "pisa.db"));
    const cfg: Config = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: [], repos: [] },
      repos: [],
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      stateDir,
    };
    const router = new Router({
      cfg,
      store,
      worker: noopWorker,
      deliverer: new GitDeliverer(cfg),
      channel: new NullChannel(),
    });
    const token = "server-token";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: createMgmtHandler({ cfg, store, router, token }),
    });
    cleanups.push(() => {
      server.stop(true);
      store.close();
      rmSync(stateDir, { recursive: true, force: true });
    });
    return { url: `http://127.0.0.1:${server.port}`, token };
  }

  test("正确 token 拿到状态，退出码 0", async () => {
    const server = startServer();
    const out: string[] = [];
    const code = await runCli(["status", "--json"], {
      target: () => server,
      stdout: (t) => out.push(t),
      stderr: () => {},
    });
    expect(code).toBe(EXIT.OK);
    const body = JSON.parse(out[0] ?? "{}") as { counts: { queued: number } };
    expect(body.counts.queued).toBe(0);
  });

  test("错误 token 退出码 3", async () => {
    const server = startServer();
    const err: string[] = [];
    const code = await runCli(["status"], {
      target: () => ({ url: server.url, token: "wrong" }),
      stdout: () => {},
      stderr: (t) => err.push(t),
    });
    expect(code).toBe(EXIT.CONFIG);
    expect(err.join("\n")).toContain("token 不正确");
  });
});
