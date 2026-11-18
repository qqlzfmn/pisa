import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { DEFAULT_WEB, type Config, type WebConfig } from "./config";
import type { Store } from "./store";
import type { ChannelAdapter, DeliveryReceipt, IncomingMessage, Task, TaskStatus } from "./types";
import { boardView, executorState, EXECUTOR_PAUSE_KEY, taskJson, type TaskJson } from "./status";
import { readTail, tailLines } from "./log";
import { WEB_UI } from "./web-ui";

/** cookie 名；页面用 `?token=` 打开后由服务端下发，之后每次请求自动带上 */
export const WEB_COOKIE = "pisa_web";
/** 详情面板展示的日志行数 */
const DETAIL_LOG_LINES = 200;
/** 日志接口单次最多返回的行数 */
const MAX_LOG_TAIL = 2000;
/** 请求体上限：派活正文与确认标志都很小 */
const MAX_BODY_BYTES = 64 * 1024;
/** 查询参数里的 token 只用于打开页面，API 一律要求请求头 */
const QUERY_TOKEN_PATHS = new Set(["/", "/ui"]);
const TICKET_ROUTE = /^\/tickets\/([\w-]+)(?:\/(stop|retry|continue|merge|rewind|logs))?$/;
const TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "paused", "succeeded", "failed", "cancelled", "rewound"];

/** 错误分类，直接决定 CLI 退出码：config → 3，其余 → 2 */
type ErrorReason = "config" | "not_found" | "conflict" | "invalid" | "error";

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
    this.inbox.set(chatId, list.slice(-DETAIL_LOG_LINES));
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

/** Web 只依赖 Router 的一个能力；Router 结构化满足它 */
export interface WebRouter {
  handle(msg: IncomingMessage): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason: ErrorReason = "invalid",
  ) {
    super(message);
  }
}

function fail(status: number, error: string, reason: ErrorReason, headers: Record<string, string> = {}): Response {
  return json({ ok: false, error, reason }, status, headers);
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
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

/** 日志文件尾部若干行，JSON 行格式化成 `HH:MM:SS stage msg` */
function logLines(cfg: Config, id: string, count: number): string[] {
  const path = join(cfg.stateDir, "logs", `${id}.log`);
  if (!existsSync(path)) return [];
  return tailLines(readTail(path), count).map((line) => {
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

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 调用方自带事件号时加 `web:` 前缀，避免与其它通道撞车 */
function optionalEventId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id) return undefined;
  if (!/^[\w:./-]{1,200}$/.test(id)) throw new HttpError(400, "eventId 只能包含字母、数字与 : . / _ -", "invalid");
  return id;
}

/** 把 Web 表单动作翻译成一条 IM 消息，交给 Router；不复制白名单、状态机与合并校验 */
function webMessage(
  cfg: Config,
  web: WebConfig,
  text: string,
  opts: { repo?: string; eventId?: string } = {},
): IncomingMessage & { threadKey: string } {
  const eventId = opts.eventId ? `web:${opts.eventId}` : `web:${randomUUID()}`;
  return {
    eventId,
    channel: "web",
    chatId: web.chatId,
    userId: web.userId,
    text: `${cfg.trigger} ${text}`,
    repo: opts.repo,
    isDirect: true,
    admin: true,
    receivedAt: Date.now(),
    // 一次表单提交就是一件事：线程与消息都绑在这个提交上
    threadKey: eventId,
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

/** 页面与 CLI 直接消费的投影：状态带中文标签，其余字段与 `TaskJson` 同源 */
interface BoardTask extends TaskJson {
  statusLabel: string;
}

function boardTask(task: Task, now: number): BoardTask {
  return { ...taskJson(task, now), statusLabel: STATUS_LABEL[task.status] ?? task.status };
}

/**
 * 本机管理 API：所有写操作都转交给 Router，Web 只做 HTTP 外壳与鉴权。
 * 返回纯函数，测试用 `new Request(...)` 直接喂，不需要真实端口。
 */
export function createWebApp(deps: WebDeps): (req: Request) => Promise<Response> {
  const { cfg, store, router, bus, token } = deps;
  const web: WebConfig = cfg.web ?? { ...DEFAULT_WEB, enabled: true, userId: "web" };
  const now = deps.now ?? Date.now;
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
      return { message: lines.join("\n"), ok: lines.length > 0 && !/^(无权限|仓库未配置|仓库路径)/.test(lines.join("\n")) };
    });
  }

  function ticketOr404(id: string): Task {
    const task = store.get(id);
    if (!task) throw new HttpError(404, `找不到任务 ${id}`, "not_found");
    return task;
  }

  /** 这条消息最后落到哪个任务；Router 建任务后写触发器绑定 */
  function boundTicket(msg: IncomingMessage & { threadKey: string }): Task | null {
    const bound = store.triggerByMessage(msg.threadKey, msg.eventId);
    return bound?.taskId ? store.get(bound.taskId) : null;
  }

  /** 回执文本里能看出是配置问题还是执行问题，CLI 据此选退出码 */
  function replyReason(message: string): ErrorReason {
    return /^(无权限|仓库未配置|仓库路径)/.test(message) ? "config" : "error";
  }

  async function createTicket(text: string, opts: { repo?: string; eventId?: string }): Promise<Response> {
    const msg = webMessage(cfg, web, text, opts);
    const result = await run(msg);
    const created = boundTicket(msg);
    if (!created) {
      const status = result.ok ? 409 : 400;
      return fail(status, result.message || "没有建出任务", result.ok ? "conflict" : replyReason(result.message));
    }
    return json({ ok: true, ticketId: created.id, ticket: boardTask(created, now()), message: result.message });
  }

  function ticketLists(repo: string | undefined, at: number) {
    return {
      running: store.listTasks({ repo, status: "running", limit: 50 }).map((t) => boardTask(t, at)),
      queued: store.listTasks({ repo, status: "queued", limit: 50 }).map((t) => boardTask(t, at)),
      finished: store.recentFinished(20, repo).map((t) => boardTask(t, at)),
    };
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const credential = requestToken(req, url);
    if (!credential || (credential.fromQuery && !QUERY_TOKEN_PATHS.has(path)) || !safeEqual(credential.token, token)) {
      return fail(401, "未授权", "config", { "www-authenticate": "Bearer" });
    }
    const cookie = credential.fromQuery
      ? { "set-cookie": `${WEB_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/` }
      : {};

    if (path === "/ui") {
      if (req.method !== "GET") return fail(405, "方法不支持", "invalid", { allow: "GET" });
      return new Response(WEB_UI, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...cookie },
      });
    }
    if (path === "/") {
      if (req.method !== "GET") return fail(405, "方法不支持", "invalid", { allow: "GET" });
      const suffix = credential.fromQuery ? `?token=${encodeURIComponent(credential.token)}` : "";
      return new Response(null, { status: 302, headers: { location: `/ui${suffix}` } });
    }

    if (path === "/state") {
      if (req.method !== "GET") return fail(405, "方法不支持", "invalid", { allow: "GET" });
      const repo = url.searchParams.get("repo") || undefined;
      const at = now();
      const view = boardView(store, cfg.worker.concurrency, at);
      return json({
        ok: true,
        daemon: view.daemon,
        executor: view.executor,
        counts: view.counts,
        total: view.total,
        repos: cfg.repos.map((r) => r.alias),
        repo: repo ?? null,
        ...ticketLists(repo, at),
      });
    }

    if (path === "/tickets") {
      if (req.method === "GET") {
        const repo = url.searchParams.get("repo") || undefined;
        const status = url.searchParams.get("status") || undefined;
        if (status && !TASK_STATUSES.includes(status as TaskStatus)) {
          return fail(400, `未知状态：${status}；可选 ${TASK_STATUSES.join("/")}`, "invalid");
        }
        const limit = clampInt(url.searchParams.get("limit"), 20, 1, 200);
        const pr = url.searchParams.get("pr");
        let tasks: Task[];
        if (pr !== null) {
          const prNumber = Number(pr);
          if (!Number.isFinite(prNumber)) return fail(400, `--pr 需要数字，收到 ${pr}`, "invalid");
          tasks = store.tasksByPr(prNumber, url.searchParams.get("github-repo") || undefined, limit);
        } else {
          tasks = store.listTasks({ repo, status: status as TaskStatus | undefined, limit });
        }
        const at = now();
        return json({ ok: true, tickets: tasks.map((t) => boardTask(t, at)), total: tasks.length });
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) return fail(400, "任务内容不能为空", "invalid");
        const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : undefined;
        return createTicket(prompt, { repo, eventId: optionalEventId(body.eventId) });
      }
      return fail(405, "方法不支持", "invalid", { allow: "GET, POST" });
    }

    if (path === "/executor/pause") {
      if (req.method !== "POST") return fail(405, "方法不支持", "invalid", { allow: "POST" });
      const body = await readJson(req);
      if (body.paused !== undefined && typeof body.paused !== "boolean") {
        return fail(400, "paused 必须是布尔值", "invalid");
      }
      const paused = body.paused === undefined ? true : body.paused;
      store.setMeta(EXECUTOR_PAUSE_KEY, paused ? "1" : "0");
      return json({ ok: true, executor: executorState(store, cfg.worker.concurrency) });
    }

    const match = TICKET_ROUTE.exec(path);
    if (!match) return fail(404, "未找到", "not_found");
    const [, id, action] = match;
    const ticketId = id as string;

    if (!action) {
      if (req.method !== "GET") return fail(405, "方法不支持", "invalid", { allow: "GET" });
      const task = ticketOr404(ticketId);
      return json({
        ok: true,
        ticket: boardTask(task, now()),
        effects: store.effectsOf(task.id).map((e) => ({ kind: e.kind, target: e.target, detail: e.detail, createdAt: e.createdAt })),
        logTail: logLines(cfg, task.id, DETAIL_LOG_LINES),
      });
    }

    if (action === "logs") {
      if (req.method !== "GET") return fail(405, "方法不支持", "invalid", { allow: "GET" });
      const task = ticketOr404(ticketId);
      const count = clampInt(url.searchParams.get("tail"), DETAIL_LOG_LINES, 1, MAX_LOG_TAIL);
      return json({ ok: true, id: task.id, lines: logLines(cfg, task.id, count) });
    }

    if (req.method !== "POST") return fail(405, "方法不支持", "invalid", { allow: "POST" });
    const ticket = ticketOr404(ticketId);
    const body = await readJson(req);

    if (action === "stop") {
      const result = await run(webMessage(cfg, web, `cancel ${ticket.id}`));
      const after = store.get(ticket.id);
      const done = Boolean(after && (after.status === "cancelled" || store.isCancelRequested(after.id)));
      return json({ ok: result.ok && done, status: after?.status ?? null, message: result.message }, done ? 200 : 409);
    }

    if (action === "retry") {
      if (ticket.status !== "failed" && ticket.status !== "cancelled") {
        return fail(409, `只有失败或已取消的任务可以重试，当前 ${ticket.status}`, "conflict");
      }
      // 有分支就在原分支上继续，没有分支则按同样的需求新开一单
      const text = ticket.branch ? `continue ${ticket.id} ${ticket.prompt}` : ticket.prompt;
      const msg = webMessage(cfg, web, text, { repo: ticket.branch ? undefined : ticket.repo });
      const result = await run(msg);
      const created = boundTicket(msg);
      if (!created) return fail(409, result.message || "重试没有建出任务", replyReason(result.message));
      return json({
        ok: true,
        ticketId: created.id,
        ticket: boardTask(created, now()),
        retriedFrom: ticket.id,
        message: result.message,
      });
    }

    if (action === "continue") {
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) return fail(400, "继续执行需要需求正文", "invalid");
      if (!ticket.branch) return fail(409, `任务 ${ticket.id} 没有可续跑的分支`, "conflict");
      return createTicket(`continue ${ticket.id} ${prompt}`, { eventId: optionalEventId(body.eventId) });
    }

    if (action === "merge") {
      if (body.confirm !== true) return fail(400, "合并需要二次确认（confirm: true）", "invalid");
      const force = body.force === true ? " --force" : "";
      const result = await run(webMessage(cfg, web, `merge ${ticket.id}${force}`));
      const after = store.get(ticket.id);
      const done = result.ok && store.effectsOf(ticket.id).some((e) => e.kind === "merge");
      return json(
        { ok: done, status: after?.status ?? null, message: result.message, restartRequired: done },
        done ? 200 : 409,
      );
    }

    if (action === "rewind") {
      const confirmed = body.confirm === true;
      const result = await run(webMessage(cfg, web, `rewind ${ticket.id}${confirmed ? " --yes" : ""}`));
      const after = store.get(ticket.id);
      const undone = after?.status === "rewound";
      const ok = result.ok && (!confirmed || undone);
      return json({ ok, status: after?.status ?? null, message: result.message, undone }, ok ? 200 : 409);
    }

    return fail(404, "未找到", "not_found");
  }

  return async (req: Request): Promise<Response> => {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message, err.reason);
      return fail(500, err instanceof Error ? err.message : String(err), "error");
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
