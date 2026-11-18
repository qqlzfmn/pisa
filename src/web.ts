import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { DEFAULT_WEB, type Config, type WebConfig } from "./config";
import type { Store } from "./store";
import type { ChannelAdapter, DeliveryReceipt, IncomingMessage, Task } from "./types";
import { daemonState, statusSnapshot, taskJson, type TaskJson } from "./status";
import { readTail, tailLines } from "./log";
import { healthOf } from "./health";
import type { ActionOutcome, Actor, ExecutorState } from "./router";
import { WEB_UI } from "./web-ui";


/** 详情面板展示的日志行数 */
const LOG_TAIL_LINES = 200;
/** 请求体上限：派活正文与确认标志都很小 */
const MAX_BODY_BYTES = 64 * 1024;
const TASK_ROUTE = /^\/api\/tasks\/([\w-]+)(?:\/(cancel|retry|merge|rewind))?$/;

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

/** Web 只依赖 Router 的这几项能力；Router 结构化满足它 */
export interface WebRouter {
  handle(msg: IncomingMessage): Promise<void>;
  cancelTask(id: string, actor: Actor): Promise<ActionOutcome>;
  retryTask(id: string, actor: Actor): Promise<ActionOutcome>;
  mergeTask(id: string, opts: { force?: boolean; actor?: Actor }): Promise<ActionOutcome>;
  rewindTask(id: string, opts: { yes?: boolean; actor?: Actor }): Promise<ActionOutcome>;
  executorState(): ExecutorState;
  setPaused(paused: boolean): ExecutorState;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
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

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 请求头里的 token：Bearer 或专用头；`/api/*` 只认这两种 */
function headerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return req.headers.get("x-pisa-token");
}

/**
 * 鉴权：接口只认请求头，凭证不进 URL（会进历史记录与日志）；
 * 页面是浏览器直接打开，只能用一次性的 `?token=` 引导，之后由页面脚本放进请求头。
 */
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

/** 把页面派活翻译成一条 IM 消息，交给 Router；不复制白名单与状态机 */
function taskMessage(cfg: Config, web: WebConfig, prompt: string, repo?: string): IncomingMessage {
  return {
    eventId: `web:${randomUUID()}`,
    channel: "web",
    chatId: web.chatId,
    userId: web.userId,
    text: `${cfg.trigger} ${prompt}`,
    repo,
    isDirect: true,
    admin: true,
    receivedAt: Date.now(),
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

/** 管理动作的 HTTP 状态：成功 200；任务不存在 404；状态冲突 409；响应体里的 code 才是给脚本用的 */
function actionStatus(outcome: ActionOutcome, taskExists: boolean): number {
  if (outcome.ok) return 200;
  return taskExists ? 409 : 404;
}

/**
 * 本机 Web 控制台：所有写操作都转交给 Router，Web 只做 HTTP 外壳与鉴权。
 * 返回纯函数，测试用 `new Request(...)` 直接喂，不需要真实端口。
 */
export function createWebApp(deps: WebDeps): (req: Request) => Promise<Response> {
  const { cfg, store, router, bus, token } = deps;
  const web: WebConfig = cfg.web ?? { ...DEFAULT_WEB, enabled: true, userId: "web" };
  const now = deps.now ?? Date.now;
  /** 本机页面即管理员：动作以 web.userId 身份执行，跳过原请求者校验 */
  const actor: Actor = { userId: web.userId, admin: true };
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

  async function dispatchTask(repo: string | undefined, prompt: string): Promise<{ taskId: string; message: string; ok: boolean }> {
    const msg = taskMessage(cfg, web, prompt, repo);
    return serialize(async () => {
      bus.take();
      await router.handle(msg);
      const lines = bus.take();
      const task = store.taskByEvent(msg.eventId);
      return {
        taskId: task?.id ?? "",
        message: lines.join("\n"),
        ok: Boolean(task) && !lines.some((l) => /^(无权限|仓库未配置|仓库路径)/.test(l)),
      };
    });
  }

  /** 看板投影：状态、计数、任务列表同源；`/api/state` 与页面共用 */
  function snapshot(repo: string | undefined): Record<string, unknown> {
    const at = now();
    const status = statusSnapshot(store);
    return {
      daemon: daemonState(store, at),
      executor: router.executorState(),
      health: healthOf(cfg, store),
      counts: status.counts,
      total: status.total,
      repos: cfg.repos.map((r) => r.alias),
      repo: repo ?? null,
      running: store.listTasks({ repo, status: "running", limit: 50 }).map((t) => boardTask(t, at)),
      queued: store.listTasks({ repo, status: "queued", limit: 50 }).map((t) => boardTask(t, at)),
      finished: store.recentFinished(20, repo).map((t) => boardTask(t, at)),
    };
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // 页面壳不含任何数据，公开返回；凭证由 `?token=` 引导进 sessionStorage，接口只认请求头
    if (req.method === "GET" && url.pathname === "/ui") {
      return new Response(WEB_UI, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (req.method === "GET" && url.pathname === "/") {
      const query = url.searchParams.get("token");
      return new Response(null, {
        status: 302,
        headers: { location: `/ui${query ? `?token=${encodeURIComponent(query)}` : ""}` },
      });
    }

    const credential = headerToken(req);
    if (!credential || !safeEqual(credential, token)) {
      return json({ ok: false, error: "未授权" }, 401, { "www-authenticate": "Bearer" });
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const repo = url.searchParams.get("repo") || undefined;
      return json({ ok: true, ...snapshot(repo) });
    }

    if (url.pathname === "/api/executor/pause") {
      if (req.method !== "POST") return json({ ok: false, error: "方法不支持" }, 405, { allow: "POST" });
      const body = await readJson(req);
      if (typeof body.paused !== "boolean") throw new HttpError(400, "paused 必须是布尔值");
      const executor = router.setPaused(body.paused);
      return json({ ok: true, code: 0, executor, message: executor.paused ? "已暂停调度" : "已恢复调度" });
    }

    if (url.pathname === "/api/tasks") {
      if (req.method === "GET") {
        return json({ ok: true, ...snapshot(url.searchParams.get("repo") || undefined) });
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) throw new HttpError(400, "任务内容不能为空");
        const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : undefined;
        const result = await dispatchTask(repo, prompt);
        return json({ ...result, taskId: result.taskId || null }, result.ok ? 200 : 400);
      }
      return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET, POST" });
    }

    const match = TASK_ROUTE.exec(url.pathname);
    if (match) {
      const [, rawId, action] = match;
      const taskId = rawId as string;
      if (action && req.method !== "POST") return json({ ok: false, error: "方法不支持" }, 405, { allow: "POST" });
      if (!action && req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
      const task = store.get(taskId);

      if (!action) {
        if (!task) return json({ ok: false, error: "找不到任务" }, 404);
        const at = now();
        return json({
          ok: true,
          task: boardTask(task, at),
          effects: store.effectsOf(task.id).map((e) => ({
            kind: e.kind,
            target: e.target,
            detail: e.detail,
            createdAt: e.createdAt,
          })),
          logTail: tailLog(cfg, task.id),
        });
      }

      const body = action === "merge" || action === "rewind" ? await readJson(req) : {};
      const outcome = await serialize(async (): Promise<ActionOutcome> => {
        if (action === "cancel") return router.cancelTask(taskId, actor);
        if (action === "retry") return router.retryTask(taskId, actor);
        if (action === "merge") {
          if (body.confirm !== true) throw new HttpError(400, "合并需要二次确认（confirm: true）");
          return router.mergeTask(taskId, { actor, force: body.force === true });
        }
        return router.rewindTask(taskId, { actor, yes: body.yes === true });
      });
      const after = store.get(taskId);
      return json(
        {
          ok: outcome.ok,
          code: outcome.code,
          status: after?.status ?? null,
          // retry 返回新任务号，其余动作返回被操作的任务号
          taskId: outcome.taskId ?? taskId,
          message: outcome.message,
        },
        actionStatus(outcome, Boolean(task)),
      );
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
