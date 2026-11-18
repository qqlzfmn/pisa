import { timingSafeEqual } from "node:crypto";
import type { Config } from "./config";
import { readLogTail } from "./log";
import { ManagementError, stateView, taskView } from "./management";
import type { Router } from "./router";
import type { Store } from "./store";
import type { TaskStatus } from "./types";

export interface ApiDeps {
  cfg: Config;
  store: Store;
  router: Router;
}

export interface ApiServerHandle {
  port: number;
  stop(): void;
}

const MAX_BODY_BYTES = 1024 * 1024;
const STATUSES: readonly string[] = ["queued", "running", "paused", "succeeded", "failed", "cancelled", "rewound"];
const HTTP_STATUS: Record<ManagementError["code"], number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 定长比较：按字节比对，避免前缀提前返回 */
function tokenMatches(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: Request): Promise<Record<string, any>> {
  const text = await req.text();
  if (!text.trim()) return {};
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new ManagementError("invalid", "请求体过大");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ManagementError("invalid", "请求体不是合法 JSON");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ManagementError("invalid", "请求体必须是 JSON 对象");
  }
  return data as Record<string, any>;
}

function listTickets(deps: ApiDeps, params: URLSearchParams) {
  const { store } = deps;
  const status = params.get("status") ?? undefined;
  if (status && !STATUSES.includes(status)) {
    throw new ManagementError("invalid", `未知状态：${status}；可选 ${STATUSES.join("/")}`);
  }
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ManagementError("invalid", "--limit 需要 1-200 的整数");
  }
  const pr = params.get("pr");
  const tasks = pr !== null
    ? store.tasksByPr(Number(pr), params.get("github-repo") ?? undefined, limit)
    : store.listTasks({ repo: params.get("repo") ?? undefined, status: status as TaskStatus | undefined, limit });
  return tasks.map(taskView);
}

function logsOf(deps: ApiDeps, id: string, params: URLSearchParams): string[] {
  if (!deps.store.get(id)) throw new ManagementError("not_found", `找不到任务 ${id}`);
  const raw = params.get("tail");
  const tail = raw === null ? 80 : Number(raw);
  if (!Number.isInteger(tail) || tail < 1 || tail > 10_000) {
    throw new ManagementError("invalid", "--tail 需要 1-10000 的整数");
  }
  return readLogTail(deps.cfg.stateDir, id, tail);
}

async function route(deps: ApiDeps, req: Request): Promise<Response> {
  const { store, router } = deps;
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const params = url.searchParams;

  if (method === "GET") {
    if (path === "/state") return json(stateView(store));
    if (path === "/tickets") return json(listTickets(deps, params));
    const logs = /^\/tickets\/([^/]+)\/logs$/.exec(path);
    if (logs) return json(logsOf(deps, decodeURIComponent(logs[1]!), params));
    const one = /^\/tickets\/([^/]+)$/.exec(path);
    if (one) {
      const task = store.get(decodeURIComponent(one[1]!));
      if (!task) throw new ManagementError("not_found", `找不到任务 ${decodeURIComponent(one[1]!)}`);
      return json(taskView(task));
    }
    return json({ error: `未知路径：GET ${path}` }, 404);
  }

  if (method === "POST") {
    if (path === "/tickets") {
      const body = await readJson(req);
      return json(router.createTicket({
        prompt: String(body.prompt ?? ""),
        repo: body.repo === undefined ? undefined : String(body.repo),
        requester: body.requester === undefined ? undefined : String(body.requester),
        eventId: body.eventId === undefined ? undefined : String(body.eventId),
        baseRef: body.baseRef === undefined ? undefined : String(body.baseRef),
        context: body.context === undefined ? undefined : String(body.context),
        prUrl: body.prUrl === undefined ? undefined : String(body.prUrl),
      }), 201);
    }
    if (path === "/executor/pause") {
      const body = await readJson(req);
      const paused = body.paused === undefined ? true : Boolean(body.paused);
      store.setExecutorPaused(paused);
      return json({ paused });
    }
    const action = /^\/tickets\/([^/]+)\/(retry|stop|merge|rewind)$/.exec(path);
    if (action) {
      const id = decodeURIComponent(action[1]!);
      const body = await readJson(req);
      switch (action[2]) {
        case "retry":
          return json(router.retryTicket(id));
        case "stop":
          return json(router.stopTicket(id));
        case "merge":
          return json(router.mergeTicket(id));
        case "rewind": {
          const report = router.rewindTicket(id, { execute: Boolean(body.execute) });
          return json({
            plan: { ...report.plan, task: taskView(report.plan.task) },
            results:
              report.results === null
                ? null
                : report.results.map((r) => ({ label: r.label, ok: r.ok, error: r.error })),
            rewound: report.rewound,
          });
        }
      }
    }
    return json({ error: `未知路径：POST ${path}` }, 404);
  }

  return json({ error: `不支持的方法：${method}` }, 405);
}

/** 只绑 127.0.0.1；令牌由调用方生成并写入 api.json */
export function startApi(deps: ApiDeps, token: string, port: number): ApiServerHandle {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const got = req.headers.get("x-pisa-token");
      if (!got || !tokenMatches(got, token)) return json({ error: "unauthorized" }, 401);
      try {
        return await route(deps, req);
      } catch (err) {
        if (err instanceof ManagementError) {
          return json({ error: err.message, code: err.code }, HTTP_STATUS[err.code]);
        }
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    },
  });
  return {
    port: server.port ?? port,
    stop: () => {
      void server.stop(true);
    },
  };
}
