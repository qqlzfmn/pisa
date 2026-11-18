import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { DEFAULT_WEB, type Config, type WebConfig } from "./config";
import type { Store } from "./store";
import type { ChannelAdapter, DeliveryReceipt, IncomingMessage, Task } from "./types";
import { daemonState, taskJson, type TaskJson } from "./status";
import { computeWindowMetrics, METRICS_WINDOW_MS } from "./metrics";
import { readTail, tailLines } from "./log";
import { WEB_UI } from "./web-ui";
import { HttpError, readJson, safeEqual } from "./http";

/** cookie 名；页面用 `?token=` 打开后由服务端下发，之后每次请求自动带上 */
export const WEB_COOKIE = "pisa_web";
/** 详情面板展示的日志行数 */
const LOG_TAIL_LINES = 200;
const TASK_ROUTE = /^\/api\/tasks\/([\w-]+)(?:\/(cancel|merge))?$/;

/**
 * Router 的回执总线：本机 Web 的 chatId 由它收集，其它 chatId 原样转发给真实通道。
 * 任务完成后的推送也走这里，因此缓冲区有上限，避免常驻进程无限增长。
 */
export class ReplyBus implements ChannelAdapter {
  readonly name = "web";
  private readonly inbox = new Map<string, string[]>();

  constructor(
    private readonly chatId: string,
    private readonly down?: ChannelAdapter,
  ) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(chatId: string, text: string): Promise<DeliveryReceipt | void> {
    if (chatId !== this.chatId) {
      await this.down?.send(chatId, text);
      return;
    }
    const list = this.inbox.get(chatId) ?? [];
    list.push(text);
    this.inbox.set(chatId, list.slice(-LOG_TAIL_LINES));
  }

  /** 取出并清空该 chatId 已累积的回执 */
  take(chatId = this.chatId): string[] {
    const list = this.inbox.get(chatId) ?? [];
    this.inbox.delete(chatId);
    return list;
  }
}

export interface WebDeps {
  cfg: Config;
  store: Store;
  router: WebRouter;
  bus: ReplyBus;
  /** 已解析的访问 token */
  token: string;
  now?: () => number;
  /** 进程启动时间（毫秒）；缺省取创建 Web 应用的时刻，作为 /health 的 uptime 起点 */
  startedAt?: number;
}

/** Web 只依赖 Router 的一个能力；Router 结构化满足它 */
export interface WebRouter {
  handle(msg: IncomingMessage): Promise<void>;
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** 请求里携带的 token：查询参数、Bearer、专用头、cookie，任一命中即可 */
function requestToken(req: Request, url: URL): { token: string; fromQuery: boolean } | null {
  const query = url.searchParams.get("token");
  if (query) return { token: query, fromQuery: true };
  const auth = req.headers.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return { token: auth.replace(/^bearer\s+/i, "").trim(), fromQuery: false };
  const header = req.headers.get("x-pisa-token");
  if (header) return { token: header, fromQuery: false };
  const cookie = cookieValue(req.headers.get("cookie"), WEB_COOKIE);
  if (cookie) return { token: cookie, fromQuery: false };
  return null;
}

function tailLog(cfg: Config, id: string): string[] {
  const path = join(cfg.stateDir, "logs", `${id}.log`);
  if (!existsSync(path)) return [];
  return tailLines(readTail(path), LOG_TAIL_LINES).map((line) => {
    try {
      const rec = JSON.parse(line) as { ts?: number; stage?: string; msg?: string };
      const time = typeof rec.ts === "number" ? new Date(rec.ts).toTimeString().slice(0, 8) : "-";
      return `${time} ${rec.stage ?? "-"} ${rec.msg ?? ""}`.trimEnd();
    } catch {
      return line;
    }
  });
}

/** 把 Web 表单动作翻译成一条 IM 消息，交给 Router；不复制白名单、状态机与合并校验 */
function webMessage(
  cfg: Config,
  web: WebConfig,
  kind: "task" | "cancel" | "merge",
  body: string,
  repo?: string,
): IncomingMessage & { threadKey: string } {
  const eventId = `web:${randomUUID()}`;
  return {
    eventId,
    channel: "web",
    chatId: web.chatId,
    userId: web.userId,
    text: `${cfg.trigger} ${kind === "task" ? body : `${kind} ${body}`}`,
    repo,
    isDirect: true,
    admin: true,
    receivedAt: Date.now(),
    // 一次表单提交就是一件事：线程与消息都绑在这个提交上
    threadKey: `web:${eventId}`,
  };
}

const STATUS_LABEL: Record<string, string> = {
  queued: "排队",
  running: "运行中",
  paused: "已中断",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  rewound: "已撤销",
};

/** 页面直接消费的投影：状态带中文标签，其余字段与 CLI 同源 */
interface BoardTask extends TaskJson {
  statusLabel: string;
}

function boardTask(task: Task, now: number): BoardTask {
  return { ...taskJson(task, now), statusLabel: STATUS_LABEL[task.status] ?? task.status };
}

/**
 * 本机 Web 控制台：所有写操作都转交给 Router，Web 只做 HTTP 外壳与鉴权。
 * 返回纯函数，测试用 `new Request(...)` 直接喂，不需要真实端口。
 */
export function createWebApp(deps: WebDeps): (req: Request) => Promise<Response> {
  const { cfg, store, router, bus, token } = deps;
  const web: WebConfig = cfg.web ?? { ...DEFAULT_WEB, enabled: true, userId: "web" };
  const now = deps.now ?? Date.now;
  const startedAt = deps.startedAt ?? now();
  // 写操作串行：回执总线按 chatId 收集，并发派活会互相偷走回复；合并也需要独占仓库
  let lock: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** 执行一条消息，返回 Router 对它的回执 */
  async function run(msg: IncomingMessage): Promise<{ message: string; ok: boolean }> {
    return serialize(async () => {
      bus.take();
      await router.handle(msg);
      const lines = bus.take();
      return { message: lines.join("\n"), ok: lines.length > 0 && !lines.some((l) => /^(无权限|仓库未配置|仓库路径)/.test(l)) };
    });
  }

  async function dispatchTask(repo: string | undefined, prompt: string): Promise<{ taskId: string; message: string; ok: boolean }> {
    const msg = webMessage(cfg, web, "task", prompt, repo);
    const result = await run(msg);
    const bound = store.triggerByMessage(msg.threadKey, msg.eventId);
    const task = bound?.taskId ? store.get(bound.taskId) : null;
    return { taskId: task?.id ?? "", ...result, ok: result.ok && Boolean(task) };
  }

  /**
   * 健康快照：只给本机监控用，不上鉴权（不含任务正文），
   * 但要求服务只监听 127.0.0.1；ok 取守护进程心跳，心跳停了即使 HTTP 还能应答也算不健康。
   */
  function healthResponse(): Response {
    const at = now();
    const daemon = daemonState(store, at);
    const counts = store.countByStatus();
    const finished = store.finishedBetween(at - METRICS_WINDOW_MS, at);
    const metrics = computeWindowMetrics(finished);
    const perRepo = new Map<string, { running: number; queued: number; finished24h: number }>();
    const ensure = (repo: string) => {
      const cur = perRepo.get(repo) ?? { running: 0, queued: 0, finished24h: 0 };
      perRepo.set(repo, cur);
      return cur;
    };
    // 配置里的仓库先占位，任务数全为 0 也要出现在健康视图里
    for (const r of cfg.repos) ensure(r.alias);
    for (const { repo, counts: c } of store.countByRepo()) {
      const cur = ensure(repo);
      cur.running = c.running;
      cur.queued = c.queued;
    }
    for (const t of finished) ensure(t.repo).finished24h += 1;
    return json(
      {
        ok: daemon.alive,
        uptimeSec: Math.max(0, Math.floor((at - startedAt) / 1000)),
        queue: counts.queued,
        running: counts.running,
        last24h: metrics,
        repos: [...perRepo].map(([repo, c]) => ({ repo, ...c })),
        daemon,
      },
      daemon.alive ? 200 : 503,
    );
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      if (req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
      return healthResponse();
    }
    const credential = requestToken(req, url);
    if (!credential || !safeEqual(credential.token, token)) {
      return json({ ok: false, error: "未授权" }, 401, { "www-authenticate": "Bearer" });
    }
    const setCookie: Record<string, string> = credential.fromQuery
      ? { "set-cookie": `${WEB_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/` }
      : {};

    if (req.method === "GET" && url.pathname === "/ui") {
      return new Response(WEB_UI, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...setCookie },
      });
    }
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(null, { status: 302, headers: { location: `/ui${credential.fromQuery ? `?token=${encodeURIComponent(credential.token)}` : ""}` } });
    }

    if (url.pathname === "/api/tasks") {
      if (req.method === "GET") {
        const repo = url.searchParams.get("repo") || undefined;
        const at = now();
        const daemon = daemonState(store, at);
        return json(
          {
            ok: true,
            daemon,
            counts: store.countByStatus(),
            repos: cfg.repos.map((r) => r.alias),
            repo: repo ?? null,
            running: store.listTasks({ repo, status: "running", limit: 50 }).map((t) => boardTask(t, at)),
            queued: store.listTasks({ repo, status: "queued", limit: 50 }).map((t) => boardTask(t, at)),
            finished: store.recentFinished(20, repo).map((t) => boardTask(t, at)),
          },
          200,
          setCookie,
        );
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) throw new HttpError(400, "任务内容不能为空");
        const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : undefined;
        const result = await dispatchTask(repo, prompt);
        return json({ ...result, taskId: result.taskId || null }, result.ok ? 200 : 400, setCookie);
      }
      return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET, POST" });
    }

    const match = TASK_ROUTE.exec(url.pathname);
    if (match) {
      const [, id, action] = match;
      if (action && req.method !== "POST") return json({ ok: false, error: "方法不支持" }, 405, { allow: "POST" });
      if (!action && req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });

      if (!action) {
        const task = store.get(id as string);
        if (!task) return json({ ok: false, error: "找不到任务" }, 404, setCookie);
        const at = now();
        return json(
          {
            ok: true,
            task: boardTask(task, at),
            effects: store.effectsOf(task.id).map((e) => ({ kind: e.kind, target: e.target, detail: e.detail, createdAt: e.createdAt })),
            logTail: tailLog(cfg, task.id),
          },
          200,
          setCookie,
        );
      }

      if (action === "merge") {
        const body = await readJson(req);
        if (body.confirm !== true) throw new HttpError(400, "合并需要二次确认（confirm: true）");
      }
      const result = await run(webMessage(cfg, web, action as "cancel" | "merge", id as string));
      const task = store.get(id as string);
      const done =
        action === "cancel"
          ? Boolean(task && (task.status === "cancelled" || store.isCancelRequested(task.id)))
          : store.effectsOf(id as string).some((e) => e.kind === "merge");
      return json({ ok: result.ok && done, status: task?.status ?? null, message: result.message }, result.ok && done ? 200 : 409, setCookie);
    }

    return json({ ok: false, error: "未找到" }, 404);
  }

  return async (req: Request): Promise<Response> => {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof HttpError) return json({ ok: false, error: err.message }, err.status);
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };
}

/** token 来自环境变量；缺失时生成一次性 token，只打印不落盘 */
export function resolveToken(web: WebConfig): { token: string; ephemeral: boolean } {
  const fromEnv = process.env[web.tokenEnv]?.trim();
  if (fromEnv) return { token: fromEnv, ephemeral: false };
  return { token: randomBytes(16).toString("hex"), ephemeral: true };
}

export interface WebServer {
  server: Server<unknown>;
  url: string;
  token: string;
  stop: () => Promise<void>;
}

/** 只监听 127.0.0.1：控制台是操作本机的工具，不暴露到网络 */
export function startWebServer(deps: Omit<WebDeps, "token">, web: WebConfig): WebServer {
  const { token, ephemeral } = resolveToken(web);
  const handle = createWebApp({ ...deps, token });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: web.port,
    // 合并要跑测试再快进，不能让空闲连接在验证中途被掐断
    idleTimeout: 255,
    fetch: handle,
  });
  const url = `http://127.0.0.1:${server.port}/ui?token=${encodeURIComponent(token)}`;
  if (ephemeral) console.log(`Web 控制台 token 未配置（${web.tokenEnv}），本次使用一次性 token：${url}`);
  else console.log(`Web 控制台：${url}`);
  return { server, url, token, stop: async () => void (await server.stop(true)) };
}
