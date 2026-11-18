import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { DEFAULT_WEB, type Config, type WebConfig } from "./config";
import type { Store } from "./store";
import type { ChannelAdapter, DeliveryReceipt, IncomingMessage, Task, TaskStatus } from "./types";
import { daemonState, ticketJson } from "./status";
import { readTail, tailLines } from "./log";
import { WEB_UI } from "./web-ui";
import { apiToken, type ApiErrorCode } from "./api";

/** 详情面板展示的日志行数 */
const LOG_TAIL_LINES = 200;
/** 请求体上限：派活正文与确认标志都很小 */
const MAX_BODY_BYTES = 64 * 1024;
const TICKET_ROUTE = /^\/tickets\/([\w-]+)(?:\/(stop|retry|merge|rewind|logs))?$/;
const EXECUTOR_ROUTE = /^\/executor\/(pause|resume)$/;
const STATUSES: readonly TaskStatus[] = ["queued", "running", "paused", "succeeded", "failed", "cancelled", "rewound"];

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
}

/** Web 只依赖 Router 的这几个能力；Router 结构化满足它 */
export interface WebRouter {
  handle(msg: IncomingMessage): Promise<void>;
  executorState(): { paused: boolean; concurrency: number; active: number };
  pauseExecutor(): { paused: boolean; concurrency: number; active: number };
  resumeExecutor(): { paused: boolean; concurrency: number; active: number };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: ApiErrorCode,
  ) {
    super(message);
  }
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function fail(status: number, message: string, code?: ApiErrorCode): Response {
  return json({ ok: false, error: message, ...(code ? { code } : {}) }, status);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 请求头里的 token：专用头或 Bearer。查询参数不参与 API 鉴权，避免 token 进历史与日志 */
function headerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) {
    const value = auth.replace(/^bearer\s+/i, "").trim();
    if (value) return value;
  }
  return req.headers.get("x-pisa-token");
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

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "请求体过大");
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface MessageOptions {
  repo?: string;
  /** CLI 传来的稳定事件号：重投落回同一个任务 */
  eventId?: string;
  requester?: string;
}

/**
 * 把管理接口的动作翻译成一条 IM 消息，交给 Router；
 * 不复制白名单、状态机与合并校验。
 */
function webMessage(
  cfg: Config,
  web: WebConfig,
  text: string,
  opts: MessageOptions = {},
): IncomingMessage & { threadKey: string } {
  const eventId = opts.eventId ? `cli:${opts.eventId}` : `web:${randomUUID()}`;
  return {
    eventId,
    channel: "web",
    chatId: web.chatId,
    userId: opts.requester ?? web.userId,
    text: `${cfg.trigger} ${text}`,
    repo: opts.repo,
    isDirect: true,
    admin: true,
    receivedAt: Date.now(),
    // 一次请求就是一件事：线程与消息都绑在它上面
    threadKey: eventId,
  };
}

/**
 * 本机管理 API：所有写操作都转交给 Router，这里只做 HTTP 外壳与鉴权。
 * 返回纯函数，测试用 `new Request(...)` 直接喂，不需要真实端口。
 */
export function createWebApp(deps: WebDeps): (req: Request) => Promise<Response> {
  const { cfg, store, router, bus, token } = deps;
  const web: WebConfig = cfg.web ?? { ...DEFAULT_WEB, enabled: true, userId: "web" };
  const now = deps.now ?? Date.now;
  // 写操作串行：回执总线按 chatId 收集，并发写会互相偷走回复；合并也需要独占仓库
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

  /** 动作型接口的统一返回：状态判定由调用方给，回执原样带上 */
  function action(id: string | undefined, message: string, ok: boolean, extra: Record<string, unknown> = {}): Response {
    const task = id ? store.get(id) : null;
    const body = { ok, ticket: task ? ticketJson(task, now()) : null, message, ...extra, ...(ok ? {} : { code: "state" }) };
    return json(body, ok ? 200 : 409);
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // 浏览器入口：URL 里的一次性 token 只用于打开页面，页面随后用请求头调 API
    if (req.method === "GET" && (url.pathname === "/ui" || url.pathname === "/")) {
      if (!web.enabled) return fail(404, "控制台未开启（web.enabled 或 --web）", "config");
      const credential = headerToken(req) ?? url.searchParams.get("token");
      if (!credential || !safeEqual(credential, token)) return fail(401, "未授权", "unauthorized");
      if (url.pathname === "/") {
        return new Response(null, { status: 302, headers: { location: "/ui" } });
      }
      return new Response(WEB_UI, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    const credential = headerToken(req);
    if (!credential || !safeEqual(credential, token)) {
      return json({ ok: false, error: "未授权", code: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }

    if (url.pathname === "/state") {
      if (req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
      const repo = url.searchParams.get("repo") || undefined;
      const at = now();
      const counts = store.countByStatus();
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      return json({
        ok: true,
        daemon: daemonState(store, at),
        executor: router.executorState(),
        counts,
        total,
        repos: cfg.repos.map((r) => ({
          alias: r.alias,
          path: r.path,
          remote: r.remote ?? null,
          baseBranch: r.baseBranch ?? null,
          allowed: cfg.whitelist.repos.length === 0 || cfg.whitelist.repos.includes(r.alias),
        })),
        repo: repo ?? null,
        running: store.listTasks({ repo, status: "running", limit: 50 }).map((t) => ticketJson(t, at)),
        queued: store.listTasks({ repo, status: "queued", limit: 50 }).map((t) => ticketJson(t, at)),
        finished: store.recentFinished(20, repo).map((t) => ticketJson(t, at)),
      });
    }

    if (url.pathname === "/tickets") {
      if (req.method === "GET") {
        const repo = url.searchParams.get("repo") || undefined;
        const status = url.searchParams.get("status") || undefined;
        if (status && !STATUSES.includes(status as TaskStatus)) {
          return fail(400, `未知状态：${status}（可选 ${STATUSES.join("、")}）`);
        }
        const limitRaw = Number(url.searchParams.get("limit") ?? 50);
        const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.trunc(limitRaw))) : 50;
        const prRaw = url.searchParams.get("pr");
        const pr = prRaw === null ? undefined : Number(prRaw);
        if (pr !== undefined && !Number.isInteger(pr)) return fail(400, `--pr 需要数字：${prRaw}`);
        const githubRepo = url.searchParams.get("githubRepo") || undefined;
        const at = now();
        const rows =
          pr === undefined
            ? store.listTasks({ repo, status: status as TaskStatus | undefined, limit })
            : store.tasksByPr(pr, githubRepo, limit);
        return json({ ok: true, tickets: rows.map((t) => ticketJson(t, at)) });
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        const prompt = trimmed(body.prompt);
        if (!prompt) return fail(400, "任务内容不能为空");
        const repo = trimmed(body.repo);
        const requester = trimmed(body.requester);
        const eventId = trimmed(body.eventId);
        const continueFrom = trimmed(body.continueFrom);
        const text = continueFrom ? `continue ${continueFrom} ${prompt}` : prompt;
        const message = webMessage(cfg, web, text, { repo, eventId, requester });
        const result = await run(message);
        // 事件号由 webMessage 生成（显式 eventId 时带 cli: 前缀），按它反查刚建出的任务
        const task = store.taskByEvent(message.eventId);
        if (!result.ok && result.message) {
          const denied = /^(无权限|仓库未配置|仓库路径)/.test(result.message);
          return fail(400, result.message, denied ? "config" : undefined);
        }
        if (!task) return fail(400, "接口未返回任务");
        return json({
          ok: true,
          ticketId: task.id,
          ticket: ticketJson(task, now()),
          // 完全重复的投递 Router 不回话，这里补一句让调用方知道落到了原任务
          message: result.message || `任务 ${task.id} 已存在`,
          daemon: daemonState(store, now()),
        });
      }
      return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET, POST" });
    }

    const executor = EXECUTOR_ROUTE.exec(url.pathname);
    if (executor) {
      if (req.method !== "POST") return json({ ok: false, error: "方法不支持" }, 405, { allow: "POST" });
      const state = executor[1] === "pause" ? router.pauseExecutor() : router.resumeExecutor();
      return json({ ok: true, executor: state });
    }

    const match = TICKET_ROUTE.exec(url.pathname);
    if (match) {
      const [, id, kind] = match;
      const task = store.get(id as string);
      if (!task) return fail(404, `找不到任务 ${id}`, "not_found");

      if (kind === "logs") {
        if (req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
        const tailRaw = Number(url.searchParams.get("tail") ?? 80);
        const tail = Number.isFinite(tailRaw) ? Math.min(2000, Math.max(1, Math.trunc(tailRaw))) : 80;
        const path = join(cfg.stateDir, "logs", `${task.id}.log`);
        const lines = existsSync(path) ? tailLines(readTail(path), tail) : [];
        return json({ ok: true, ticketId: task.id, path, lines });
      }

      if (!kind) {
        if (req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
        const at = now();
        return json({
          ok: true,
          ticket: ticketJson(task, at),
          effects: store.effectsOf(task.id).map((e) => ({ kind: e.kind, target: e.target, detail: e.detail, createdAt: e.createdAt })),
          logTail: tailLog(cfg, task.id),
        });
      }

      if (req.method !== "POST") return json({ ok: false, error: "方法不支持" }, 405, { allow: "POST" });

      if (kind === "stop") {
        const result = await run(webMessage(cfg, web, `cancel ${task.id}`));
        const after = store.get(task.id);
        const done = Boolean(after && (after.status === "cancelled" || store.isCancelRequested(after.id)));
        return action(task.id, result.message, result.ok && done);
      }

      if (kind === "retry") {
        const result = await run(webMessage(cfg, web, `retry ${task.id}`));
        const after = store.get(task.id);
        const done = Boolean(after && (after.status === "queued" || after.status === "running"));
        return action(task.id, result.message, result.ok && done);
      }

      if (kind === "merge") {
        const body = await readJson(req);
        if (body.confirm !== true) return fail(400, "合并需要二次确认（confirm: true）");
        const force = body.force === true ? " --force" : "";
        const result = await run(webMessage(cfg, web, `merge ${task.id}${force}`));
        const merged = store.effectsOf(task.id).some((e) => e.kind === "merge");
        return action(task.id, result.message, merged, { restartRequired: merged });
      }

      const body = await readJson(req);
      const confirm = body.confirm === true;
      const result = await run(webMessage(cfg, web, `rewind ${task.id}${confirm ? " --yes" : ""}`));
      const after = store.get(task.id);
      const applied = after?.status === "rewound";
      return action(task.id, result.message, result.ok && (!confirm || applied), { applied });
    }

    return fail(404, "未找到", "not_found");
  }

  return async (req: Request): Promise<Response> => {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message, err.code);
      return fail(500, err instanceof Error ? err.message : String(err));
    }
  };
}

export interface WebServer {
  server: Server<unknown>;
  /** 管理接口根地址，CLI 用它拼请求 */
  base: string;
  /** 浏览器入口（带一次性 token） */
  url: string;
  token: string;
  stop: () => Promise<void>;
}

/**
 * 只监听 127.0.0.1：管理面是操作本机的工具，不暴露到网络。
 * token 与 CLI 共用 `<stateDir>/api.token`（或 `web.tokenEnv` 指定的环境变量）。
 */
export function startWebServer(deps: Omit<WebDeps, "token">, web: WebConfig): WebServer {
  const token = apiToken(deps.cfg);
  const handle = createWebApp({ ...deps, token });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: web.port,
    // 合并要跑测试再快进，不能让空闲连接在验证中途被掐断
    idleTimeout: 255,
    fetch: handle,
  });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    server,
    base,
    url: `${base}/ui?token=${encodeURIComponent(token)}`,
    token,
    stop: async () => void (await server.stop(true)),
  };
}
