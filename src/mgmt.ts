import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_WEB, type Config, type WebConfig } from "./config";
import { HttpError, json, readJson, safeEqual } from "./http";
import { taskLogTail } from "./log";
import { windowMetrics } from "./metrics";
import { boardView, daemonState, taskJson } from "./status";
import type { Store } from "./store";
import type { IncomingMessage, TaskStatus } from "./types";

/** 管理接口的 token 文件：守护进程启动时写入，CLI 在环境变量缺失时读它 */
export const MGMT_TOKEN_FILE = "mgmt.token";

export function managementTokenPath(stateDir: string): string {
  return join(stateDir, MGMT_TOKEN_FILE);
}

/** 0600 写入：只给本机同用户读取 */
export function writeManagementToken(stateDir: string, token: string): void {
  mkdirSync(stateDir, { recursive: true });
  const path = managementTokenPath(stateDir);
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readManagementToken(stateDir: string): string | null {
  try {
    const token = readFileSync(managementTokenPath(stateDir), "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/** 管理接口的机器可读错误分类；CLI 据 config/auth 判定「待配置」 */
export type ManagementErrorCode = "usage" | "config" | "auth" | "state";

export interface ExecutorState {
  paused: boolean;
  active: number;
  concurrency: number;
}

export interface RetryResult {
  ok: boolean;
  taskId: string | null;
  message: string;
  code?: "not-found" | "config" | "state";
}

/** 管理接口要求的 Router 能力；Router 结构化满足 */
export interface ManagementRouter {
  retryTask(taskId: string, requester: string): Promise<RetryResult>;
  pauseExecutor(paused: boolean): void;
  executorState(): ExecutorState;
}

export interface ManagementDeps {
  cfg: Config;
  store: Store;
  /** 已解析的访问 token */
  token: string;
  now: () => number;
  /** 执行一条管理消息并收集回执；串行由调用方保证 */
  run(msg: IncomingMessage): Promise<{ message: string; ok: boolean }>;
  router: ManagementRouter;
}

type ControlCommand = "task" | "continue" | "cancel" | "merge" | "rewind";

/** 一次管理请求的触发身份：token 即 auth，admin 跳过原请求者校验 */
export function controlMessage(
  cfg: Config,
  identity: { userId: string; chatId: string },
  kind: ControlCommand,
  body: string,
  repo?: string,
  eventId?: string,
): IncomingMessage & { threadKey: string } {
  const id = eventId?.trim() || `api:${randomUUID()}`;
  return {
    eventId: id,
    channel: "api",
    chatId: identity.chatId,
    userId: identity.userId,
    text: `${cfg.trigger} ${kind === "task" ? body : `${kind} ${body}`}`,
    repo,
    isDirect: true,
    admin: true,
    receivedAt: Date.now(),
    threadKey: `api:${id}`,
  };
}

const STATE_PATH = "/state";
const TICKETS_PATH = "/tickets";
const EXECUTOR_PAUSE_PATH = "/executor/pause";
const TICKET_ROUTE = /^\/tickets\/([\w-]+)(?:\/(retry|stop|merge|rewind))?$/;
const STATUSES: readonly TaskStatus[] = ["queued", "running", "paused", "succeeded", "failed", "cancelled", "rewound"];
const MAX_LOG_TAIL = 500;

/** 管理路径先于浏览器鉴权分派：这些路由只认请求头 */
export function isManagementPath(pathname: string): boolean {
  return pathname === STATE_PATH || pathname === EXECUTOR_PAUSE_PATH || pathname.startsWith(`${TICKETS_PATH}/`) || pathname === TICKETS_PATH;
}

function fail(status: number, code: ManagementErrorCode, error: string): Response {
  return json({ ok: false, code, error }, status);
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, code: "usage", error: "方法不支持" }, 405, { allow });
}

/** 只认请求头；query 与 cookie 是浏览器会话的凭证，管理接口不接受 */
function headerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim() || null;
  return req.headers.get("x-pisa-token")?.trim() || null;
}

/** DNS rebinding 防护：浏览器一定带 Host，主机名不是回环就拒绝 */
function loopbackHost(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return true;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

function identityOf(cfg: Config): { userId: string; chatId: string } {
  const web: WebConfig = cfg.web ?? DEFAULT_WEB;
  return { userId: web.userId, chatId: web.chatId };
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * 管理接口：查询与操作共用一套 JSON，写操作全部翻译成 Router 命令。
 * 与 Web 控制台共用一台 HTTP 服务，但鉴权、错误体与投影独立：脚本不看 cookie。
 */
export function createManagementApi(deps: ManagementDeps): (req: Request, url: URL) => Promise<Response> {
  const { cfg, store, router } = deps;

  function stateResponse(): Response {
    const at = deps.now();
    const view = boardView(store, at, { queued: 50, finished: 20 });
    return json({
      ok: true,
      daemon: daemonState(store, at),
      executor: router.executorState(),
      repos: cfg.repos.map((r) => r.alias),
      counts: view.counts,
      total: view.total,
      running: view.running,
      queued: view.queued,
      finished: view.finished,
      last24h: windowMetrics(store, at),
    });
  }

  function ticketDetail(id: string, url: URL): Response {
    const task = store.get(id);
    if (!task) return fail(404, "state", `找不到任务 ${id}`);
    const tail = intParam(url, "logTail", 200, 1, MAX_LOG_TAIL);
    if (tail === null) return fail(400, "usage", "logTail 需要数字");
    return json({
      ok: true,
      task: taskJson(task, deps.now()),
      effects: store.effectsOf(id).map((e) => ({ kind: e.kind, target: e.target, detail: e.detail, createdAt: e.createdAt })),
      logTail: taskLogTail(cfg.stateDir, id, tail),
    });
  }

  function ticketList(url: URL): Response {
    const repo = url.searchParams.get("repo") || undefined;
    const status = url.searchParams.get("status") || undefined;
    if (status && !STATUSES.includes(status as TaskStatus)) {
      return fail(400, "usage", `未知状态：${status}；可选 ${STATUSES.join("/")}`);
    }
    const limit = intParam(url, "limit", 20, 1, 200);
    if (limit === null) return fail(400, "usage", "limit 需要数字");
    const pr = intParam(url, "pr", 0, 0, Number.MAX_SAFE_INTEGER);
    if (pr === null) return fail(400, "usage", "pr 需要数字");
    const tasks = pr
      ? store.tasksByPr(pr, url.searchParams.get("github-repo") ?? undefined, limit)
      : store.listTasks({ repo, status: status as TaskStatus | undefined, limit });
    return json({ ok: true, tickets: tasks.map((t) => taskJson(t, deps.now())) });
  }

  async function createTicket(req: Request): Promise<Response> {
    const body = await readJson(req);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return fail(400, "usage", "任务内容不能为空");
    const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : undefined;
    const parent = typeof body.continueFrom === "string" ? body.continueFrom.trim() : "";
    const eventId = typeof body.eventId === "string" ? body.eventId.trim() : undefined;
    const msg = parent
      ? controlMessage(cfg, identityOf(cfg), "continue", `${parent} ${prompt}`, repo, eventId)
      : controlMessage(cfg, identityOf(cfg), "task", prompt, repo, eventId);
    const result = await deps.run(msg);
    const bound = store.triggerByMessage(msg.threadKey, msg.eventId);
    const task = bound?.taskId ? store.get(bound.taskId) : null;
    if (!task) {
      // 回执里能看出仓库或权限没配好：脚本按「待配置」处理
      const code: ManagementErrorCode = /^(无权限|仓库未配置|仓库路径)/.test(result.message) ? "config" : "state";
      return fail(result.ok ? 500 : 400, code, result.message || "任务未创建");
    }
    return json({ ok: true, taskId: task.id, task: taskJson(task, deps.now()), message: result.message });
  }

  async function ticketAction(req: Request, id: string, action: string): Promise<Response> {
    if (action === "stop") {
      const result = await deps.run(controlMessage(cfg, identityOf(cfg), "cancel", id));
      const task = store.get(id);
      const done = Boolean(task && (task.status === "cancelled" || store.isCancelRequested(task.id)));
      if (!done) return fail(409, "state", result.message || `任务 ${id} 无法停止`);
      return json({ ok: true, status: task?.status ?? null, message: result.message });
    }

    if (action === "retry") {
      const result = await router.retryTask(id, identityOf(cfg).userId);
      if (!result.ok) {
        const status = result.code === "not-found" ? 404 : result.code === "config" ? 400 : 409;
        return fail(status, result.code === "config" ? "config" : "state", result.message);
      }
      const task = result.taskId ? store.get(result.taskId) : null;
      return json({ ok: true, taskId: result.taskId, task: task ? taskJson(task, deps.now()) : null, message: result.message });
    }

    if (action === "merge") {
      const body = await readJson(req);
      if (body.confirm !== true) return fail(400, "usage", "合并需要二次确认（confirm: true）");
      const arg = body.force === true ? `${id} --force` : id;
      const result = await deps.run(controlMessage(cfg, identityOf(cfg), "merge", arg));
      const merged = store.effectsOf(id).some((e) => e.kind === "merge");
      if (!merged) return fail(409, "state", result.message);
      const task = store.get(id);
      return json({
        ok: true,
        status: task?.status ?? null,
        restart: process.env.PISA_SUPERVISED === "1" ? "auto" : "manual",
        message: result.message,
      });
    }

    // rewind：不带 confirm 只给预览，与控制台一致
    const body = await readJson(req);
    const apply = body.confirm === true;
    const result = await deps.run(controlMessage(cfg, identityOf(cfg), "rewind", apply ? `${id} --yes` : id));
    const task = store.get(id);
    if (apply && task?.status !== "rewound") return fail(409, "state", result.message);
    return json({ ok: true, status: task?.status ?? null, applied: apply, message: result.message });
  }

  async function pauseExecutor(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (typeof body.paused !== "boolean") return fail(400, "usage", "paused 需要布尔值");
    router.pauseExecutor(body.paused);
    return json({ ok: true, executor: router.executorState() });
  }

  async function route(req: Request, url: URL): Promise<Response> {
    if (!loopbackHost(req)) return fail(403, "auth", "只接受本机回环地址");
    const given = headerToken(req);
    if (!given || !safeEqual(given, deps.token)) {
      return json({ ok: false, code: "auth", error: "未授权" }, 401, { "www-authenticate": "Bearer" });
    }

    if (url.pathname === STATE_PATH) {
      if (req.method !== "GET") return methodNotAllowed("GET");
      return stateResponse();
    }

    if (url.pathname === EXECUTOR_PAUSE_PATH) {
      if (req.method !== "POST") return methodNotAllowed("POST");
      return pauseExecutor(req);
    }

    if (url.pathname === TICKETS_PATH) {
      if (req.method === "GET") return ticketList(url);
      if (req.method === "POST") return createTicket(req);
      return methodNotAllowed("GET, POST");
    }

    const match = TICKET_ROUTE.exec(url.pathname);
    if (!match) return fail(404, "state", "未找到");
    const [, id, action] = match as unknown as [string, string, string | undefined];
    if (action) {
      if (req.method !== "POST") return methodNotAllowed("POST");
      return ticketAction(req, id, action);
    }
    if (req.method !== "GET") return methodNotAllowed("GET");
    return ticketDetail(id, url);
  }

  return async (req: Request, url: URL): Promise<Response> => {
    try {
      return await route(req, url);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, "usage", err.message);
      return fail(500, "state", err instanceof Error ? err.message : String(err));
    }
  };
}
