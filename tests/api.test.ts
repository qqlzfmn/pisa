import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTaskId } from "../src/ids";
import type { Task } from "../src/types";
import { startHarness, type Harness } from "./api-harness";

let h: Harness | undefined;

afterEach(() => {
  h?.stop();
  h = undefined;
});

interface StateJson {
  daemon: { alive: boolean };
  executor: { paused: boolean };
  total: number;
  counts: Record<string, number>;
  queued: Array<{ prompt: string }>;
}

interface TicketJson {
  id: string;
  status: string;
  repo: string;
  prompt: string;
}

interface TicketResultJson {
  created: boolean;
  ticket: TicketJson;
}

interface ErrorJson {
  error: string;
  code?: string;
}

interface StopJson {
  state: string;
  message: string;
}

async function call<T = unknown>(
  path: string,
  init: { method?: "GET" | "POST"; token?: string | null; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const server = h!;
  const headers: Record<string, string> = {};
  const token = init.token === undefined ? server.token : init.token;
  if (token !== null) headers["x-pisa-token"] = token;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  // 测试端只断言结构，响应形状由接口测试本身约束
  const data = (text ? JSON.parse(text) : null) as T;
  return { status: res.status, data };
}

function seed(over: Partial<Task> = {}): Task {
  const task: Task = {
    id: newTaskId(),
    source: `seed:${Math.random().toString(36).slice(2)}`,
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

describe("鉴权", () => {
  test("缺少或错误令牌一律 401，且不解析请求体", async () => {
    h = startHarness();
    expect((await call("/state", { token: null })).status).toBe(401);
    expect((await call("/state", { token: "wrong" })).status).toBe(401);

    const denied = await call("/tickets", { method: "POST", token: "wrong", body: { prompt: "x" } });
    expect(denied.status).toBe(401);
    expect(h.store.listTasks().length).toBe(0);

    const brokenJson = await call("/tickets", { method: "POST", token: null, body: undefined });
    expect(brokenJson.status).toBe(401);
  });
});

describe("读接口", () => {
  test("GET /state 返回看板与执行器状态", async () => {
    h = startHarness();
    seed({ prompt: "排队中" });
    const reply = await call<StateJson>("/state");
    expect(reply.status).toBe(200);
    expect(reply.data.daemon.alive).toBe(true);
    expect(reply.data.executor.paused).toBe(false);
    expect(reply.data.total).toBe(1);
    expect(reply.data.counts.queued).toBe(1);
    expect(reply.data.queued[0]!.prompt).toBe("排队中");
  });

  test("GET /tickets 支持 repo/status/limit/pr 过滤", async () => {
    h = startHarness();
    seed({ prompt: "queued one" });
    seed({ prompt: "done", status: "succeeded", prUrl: "https://github.com/o/r/pull/42" });
    seed({ prompt: "other pr", status: "succeeded", prUrl: "https://github.com/o/r/pull/43" });

    const queued = await call<TicketJson[]>("/tickets?status=queued");
    expect(queued.status).toBe(200);
    expect(queued.data.map((t) => t.prompt)).toEqual(["queued one"]);

    const byPr = await call<TicketJson[]>("/tickets?pr=42");
    expect(byPr.data.map((t) => t.prompt)).toEqual(["done"]);

    expect((await call("/tickets?limit=0")).status).toBe(400);
    expect((await call("/tickets?status=nope")).status).toBe(400);
  });

  test("GET /tickets/:id 与 logs", async () => {
    h = startHarness();
    const task = seed();
    const one = await call<TicketJson>(`/tickets/${task.id}`);
    expect(one.status).toBe(200);
    expect(one.data.id).toBe(task.id);

    expect((await call("/tickets/t_missing")).status).toBe(404);
    expect((await call<string[]>(`/tickets/${task.id}/logs`)).data).toEqual([]);

    mkdirSync(join(h.stateDir, "logs"), { recursive: true });
    writeFileSync(join(h.stateDir, "logs", `${task.id}.log`), "a\nb\nc\n");
    expect((await call<string[]>(`/tickets/${task.id}/logs?tail=2`)).data).toEqual(["b", "c"]);
    expect((await call("/tickets/t_missing/logs")).status).toBe(404);
    expect((await call(`/tickets/${task.id}/logs?tail=0`)).status).toBe(400);
  });
});

describe("写接口", () => {
  test("POST /tickets 建单、幂等与校验", async () => {
    h = startHarness();
    const created = await call<TicketResultJson>("/tickets", { method: "POST", body: { prompt: "修 CI", requester: "u9", eventId: "e1" } });
    expect(created.status).toBe(201);
    expect(created.data.created).toBe(true);
    expect(created.data.ticket.status).toBe("queued");
    expect(created.data.ticket.repo).toBe("demo");
    expect(h.store.get(created.data.ticket.id)!.requester).toBe("u9");

    const again = await call<TicketResultJson>("/tickets", { method: "POST", body: { prompt: "修 CI", eventId: "e1" } });
    expect(again.status).toBe(201);
    expect(again.data.created).toBe(false);
    expect(again.data.ticket.id).toBe(created.data.ticket.id);
    expect(h.store.listTasks().length).toBe(1);

    const empty = await call<ErrorJson>("/tickets", { method: "POST", body: { prompt: "  " } });
    expect(empty.status).toBe(400);
    expect(empty.data.code).toBe("invalid");
    expect((await call("/tickets", { method: "POST", body: { prompt: "x", repo: "nope" } })).status).toBe(400);
  });

  test("POST /tickets 拒绝未授权与不是 git 仓库的仓库", async () => {
    const plain = mkdtempSync(join(tmpdir(), "pisa-plain-"));
    h = startHarness({
      cfg: (cfg) => {
        cfg.whitelist.repos = ["plain"];
        cfg.repos.push({ alias: "plain", path: plain });
      },
    });
    const denied = await call<ErrorJson>("/tickets", { method: "POST", body: { prompt: "x", repo: "demo" } });
    expect(denied.status).toBe(400);
    expect(denied.data.code).toBe("invalid");
    expect(denied.data.error).toContain("不在 whitelist.repos");

    const notGit = await call<ErrorJson>("/tickets", { method: "POST", body: { prompt: "x", repo: "plain" } });
    expect(notGit.status).toBe(400);
    expect(notGit.data.code).toBe("invalid");
    expect(notGit.data.error).toContain("不是 git 仓库");
  });

  test("POST /tickets 继承续跑上下文", async () => {
    h = startHarness();
    const reply = await call<TicketResultJson>("/tickets", {
      method: "POST",
      body: { prompt: "继续改", baseRef: "pisa/x", context: "上一轮", prUrl: "https://github.com/o/r/pull/1" },
    });
    const task = h.store.get(reply.data.ticket.id)!;
    expect(task.baseRef).toBe("pisa/x");
    expect(task.context).toBe("上一轮");
    expect(task.prUrl).toBe("https://github.com/o/r/pull/1");
  });

  test("retry 只接受失败或取消的任务，重复调用返回同一新任务", async () => {
    h = startHarness();
    const failed = seed({ status: "failed", error: "炸了" });
    const first = await call<TicketResultJson>(`/tickets/${failed.id}/retry`, { method: "POST", body: {} });
    expect(first.status).toBe(200);
    expect(first.data.created).toBe(true);
    const child = h.store.get(first.data.ticket.id)!;
    expect(child.prompt).toBe(failed.prompt);
    expect(child.requester).toBe(failed.requester);

    const second = await call<TicketResultJson>(`/tickets/${failed.id}/retry`, { method: "POST", body: {} });
    expect(second.data.created).toBe(false);
    expect(second.data.ticket.id).toBe(child.id);

    const queued = seed();
    expect((await call(`/tickets/${queued.id}/retry`, { method: "POST", body: {} })).status).toBe(409);
    expect((await call("/tickets/t_missing/retry", { method: "POST", body: {} })).status).toBe(404);
  });

  test("stop 取消排队任务，终态与缺失任务被拒", async () => {
    h = startHarness();
    const queued = seed();
    const stopped = await call<StopJson>(`/tickets/${queued.id}/stop`, { method: "POST", body: {} });
    expect(stopped.status).toBe(200);
    expect(stopped.data.state).toBe("cancelled");
    expect(h.store.get(queued.id)!.status).toBe("cancelled");

    expect((await call(`/tickets/${queued.id}/stop`, { method: "POST", body: {} })).status).toBe(409);
    expect((await call("/tickets/t_missing/stop", { method: "POST", body: {} })).status).toBe(404);
  });

  test("stop 对遗留 running 任务直接取消，对活跃任务只登记请求", async () => {
    h = startHarness();
    const orphan = seed({ status: "running", startedAt: Date.now() });
    const reply = await call<StopJson>(`/tickets/${orphan.id}/stop`, { method: "POST", body: {} });
    expect(reply.data.state).toBe("cancelled");
    expect(reply.data.message).toContain("无活跃执行器");
    expect(h.store.get(orphan.id)!.status).toBe("cancelled");
  });

  test("merge 对未成功任务返回 409", async () => {
    h = startHarness();
    const queued = seed();
    expect((await call(`/tickets/${queued.id}/merge`, { method: "POST", body: {} })).status).toBe(409);
    expect((await call("/tickets/t_missing/merge", { method: "POST", body: {} })).status).toBe(404);
  });

  test("executor/pause 持久化并阻止领取排队任务", async () => {
    h = startHarness();
    seed();
    const paused = await call<{ paused: boolean }>("/executor/pause", { method: "POST", body: {} });
    expect(paused.data).toEqual({ paused: true });
    expect(h.store.executorPaused()).toBe(true);
    expect(await h.router.drainOnce()).toBe(false);
    expect(h.store.listTasks({ status: "queued" }).length).toBe(1);

    expect((await call<{ paused: boolean }>("/executor/pause", { method: "POST", body: { paused: false } })).data).toEqual({ paused: false });
    expect(h.store.executorPaused()).toBe(false);
  });

  test("rewind 默认只预览，运行中任务被拒", async () => {
    h = startHarness();
    const done = seed({ status: "succeeded", branch: "pisa/x" });
    const preview = await call<{ plan: { task: { id: string } }; results: unknown; rewound: boolean }>(`/tickets/${done.id}/rewind`, { method: "POST", body: {} });
    expect(preview.status).toBe(200);
    expect(preview.data.results).toBeNull();
    expect(preview.data.rewound).toBe(false);
    expect(preview.data.plan.task.id).toBe(done.id);

    const running = seed({ status: "running", startedAt: Date.now() });
    const rejected = await call(`/tickets/${running.id}/rewind`, { method: "POST", body: { execute: true } });
    expect(rejected.status).toBe(409);
  });

  test("未知路径与不支持的方法", async () => {
    h = startHarness();
    expect((await call("/nope")).status).toBe(404);
    expect((await call("/tickets", { method: "POST", body: [] })).status).toBe(400);
  });
});
