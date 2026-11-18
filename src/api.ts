import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import type { Store } from "./store";
import { isTaskStatus, type IncomingMessage, type Task, type TaskStatus } from "./types";
import { daemonState, formatStatusBoard, statusSnapshot, taskJson, type TaskJson } from "./status";
import { windowMetrics } from "./metrics";
import { readTail, tailLines } from "./log";
import { HttpError, json, readJson } from "./http";
import type { ReplyBus } from "./channels/reply-bus";

/** 管理接口投递的任务记为这个入口：与 IM、评论、webhook 区分开 */
export const API_CHANNEL = "api";
/** 管理接口的回执会话：ReplyBus 按 chatId 缓冲，异步通知不会漏进真实通道 */
export const API_CHAT_ID = "api";

/** 详情面板展示的日志行数 */
const LOG_TAIL_LINES = 200;
const TASK_ROUTE = /^\/api\/tasks\/([\w-]+)(?:\/(cancel|resume|retry|continue|merge|rewind|logs))?$/;

export interface ApiRouter {
  handle(msg: IncomingMessage): Promise<void>;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}

export interface ApiDeps {
  cfg: Config;
  store: Store;
  router: ApiRouter;
  bus: ReplyBus;
  now?: () => number;
}

/** JSON 日志行压成 `时:分:秒 阶段 正文`；坏行原样返回 */
function logLine(line: string): string {
  try {
    const rec = JSON.parse(line) as { ts?: number; stage?: string; msg?: string };
    const time = typeof rec.ts === "number" ? new Date(rec.ts).toTimeString().slice(0, 8) : "-";
    return `${time} ${rec.stage ?? "-"} ${rec.msg ?? ""}`.trimEnd();
  } catch {
    return line;
  }
}

function tailLog(cfg: Config, id: string, count = LOG_TAIL_LINES): string[] {
  const path = join(cfg.stateDir, "logs", `${id}.log`);
  if (!existsSync(path)) return [];
  return tailLines(readTail(path), count).map(logLine);
}

/**
 * 管理接口：CLI、脚本与看板都走这里，守护进程因此是唯一写入口。
 *
 * 所有写操作翻译成一条 `channel: "api"` 的 Router 消息，白名单、状态机、
 * 去重与合并校验都留在 Router 一处。动作是否成功只看任务状态与效果行，
 * 不解析中文回执；失败时用 `reason` 告诉调用方该修配置、等状态还是查部件。
 */
export function createApi(deps: ApiDeps): (req: Request, url: URL) => Promise<Response> {
  const { cfg, store, router, bus } = deps;
  const now = deps.now ?? Date.now;
  // 写操作串行：回执总线按会话收集，并发派活会互相偷走回复；合并也需要独占仓库
  let lock: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** 把一次请求翻译成 Router 消息；正文按聊天指令解析，动作带命令名 */
  function message(
    text: string,
    fields: { eventId?: string; requester?: string; repo?: string } = {},
  ): IncomingMessage & { threadKey: string } {
    const eventId = fields.eventId?.trim() || `${API_CHANNEL}:${randomUUID()}`;
    return {
      eventId,
      channel: API_CHANNEL,
      chatId: API_CHAT_ID,
      userId: fields.requester?.trim() || cfg.web?.userId || "local",
      text,
      repo: fields.repo,
      isDirect: true,
      // 请求已由本机 token 认证：跳过误触防护与原请求者校验，用户白名单也不适用
      admin: true,
      receivedAt: now(),
      threadKey: `${API_CHANNEL}:${eventId}`,
    };
  }

  /** 新产生的任务本体：CLI 拿它直接排版，页面走 /api/board */
  function taskPayload(taskId: string | null): TaskJson | null {
    const task = taskId ? store.get(taskId) : null;
    return task ? taskJson(task, now()) : null;
  }

  /** 执行一条消息：返回路由回执，以及这次投递绑定的任务号 */
  async function dispatch(msg: IncomingMessage & { threadKey: string }): Promise<{ message: string; taskId: string | null }> {
    return serialize(async () => {
      bus.take(API_CHAT_ID);
      await router.handle(msg);
      const message = bus.take(API_CHAT_ID).join("\n");
      const bound = store.triggerByMessage(msg.threadKey, msg.eventId);
      return { message, taskId: bound?.taskId ?? null };
    });
  }

  function executor(): { paused: boolean; running: number; limit: number } {
    return { paused: router.isPaused(), running: store.countByStatus().running, limit: cfg.worker.concurrency ?? 1 };
  }

  function taskOr404(id: string): Task {
    const task = store.get(id);
    if (!task) throw new HttpError(404, `找不到任务 ${id}`);
    return task;
  }

  /**
   * 动作结果：回执不参与判定，只看任务状态与效果行。
   * 失败按原因归类——状态没到就是 `state`，状态对了但执行失败才是 `component`。
   */
  function verdict(id: string, action: string, message: string): Response {
    const task = store.get(id);
    const status = task?.status ?? null;
    if (action === "cancel") {
      const done = Boolean(task && (task.status === "cancelled" || store.isCancelRequested(task.id)));
      if (done) return json({ ok: true, id, status, message });
      throw new HttpError(409, message || `任务 ${id} 处于 ${status}，无法取消`);
    }
    if (action === "resume") {
      // 只有真的离开了中断态才算恢复：paused（工作副本缺失等拒绝）与 queued 都算没恢复
      if (status && status !== "paused" && status !== "queued") return json({ ok: true, id, status, message });
      throw new HttpError(409, message || `任务 ${id} 处于 ${status}，无法恢复`);
    }
    if (action === "merge") {
      const merged = store.effectsOf(id).some((e) => e.kind === "merge");
      if (merged) return json({ ok: true, id, status, message });
      throw new HttpError(409, message || `任务 ${id} 没有合并`, status === "succeeded" ? "component" : "state");
    }
    if (action === "rewind") {
      if (status === "rewound") return json({ ok: true, id, status, message });
      throw new HttpError(
        409,
        message || `任务 ${id} 撤销失败`,
        status === "queued" || status === "running" || status === "paused" ? "state" : "component",
      );
    }
    throw new HttpError(409, message || `任务 ${id} 无法执行 ${action}`);
  }

  async function state(): Promise<Response> {
    const at = now();
    const daemon = daemonState(store, at);
    const snapshot = statusSnapshot(store);
    const paused = router.isPaused();
    return json({
      ok: daemon.alive && !paused,
      daemon,
      executor: executor(),
      counts: snapshot.counts,
      total: snapshot.total,
      running: snapshot.running.map((t) => taskJson(t, at)),
      queued: snapshot.queued.map((t) => taskJson(t, at)),
      finished: snapshot.finished.map((t) => taskJson(t, at)),
      last24h: windowMetrics(store, at),
      repos: cfg.repos.map((r) => ({
        alias: r.alias,
        path: r.path,
        remote: r.remote ?? null,
        baseBranch: r.baseBranch ?? null,
        allowed: cfg.whitelist.repos.length === 0 || cfg.whitelist.repos.includes(r.alias),
      })),
      // 人类可读的看板：终端展示与 IM `status` 同源，避免两套排版
      text: formatStatusBoard(store, at, { paused }),
    });
  }

  /** 页面看板：分组 + 中文状态标签，与 CLI 的 `list --json` 分开 */
  function board(url: URL): Response {
    const repo = url.searchParams.get("repo") || undefined;
    const at = now();
    return json({
      ok: true,
      daemon: daemonState(store, at),
      counts: store.countByStatus(),
      repos: cfg.repos.map((r) => r.alias),
      repo: repo ?? null,
      running: store.listTasks({ repo, status: "running", limit: 50 }).map((t) => taskJson(t, at)),
      queued: store.listTasks({ repo, status: "queued", limit: 50 }).map((t) => taskJson(t, at)),
      finished: store.recentFinished(20, repo).map((t) => taskJson(t, at)),
    });
  }

  /** 状态筛选：未知值直接 400，避免把空列表当成「没有任务」 */
  function statusFilter(url: URL): TaskStatus | undefined {
    const raw = url.searchParams.get("status");
    if (!raw) return undefined;
    if (!isTaskStatus(raw)) throw new HttpError(400, `未知状态：${raw}`);
    return raw;
  }

  function tasks(url: URL): Response {
    const repo = url.searchParams.get("repo") || undefined;
    const status = statusFilter(url);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const pr = Number(url.searchParams.get("pr"));
    const rows = Number.isFinite(pr) && pr > 0 ? store.tasksByPr(pr, repo, limit) : store.listTasks({ repo, status, limit });
    const at = now();
    return json({ ok: true, tasks: rows.map((t) => taskJson(t, at)) });
  }

  async function submit(req: Request): Promise<Response> {
    const body = await readJson(req);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) throw new HttpError(400, "任务内容不能为空");
    const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : undefined;
    const result = await dispatch(
      message(prompt, {
        eventId: typeof body.eventId === "string" ? body.eventId : undefined,
        requester: typeof body.requester === "string" ? body.requester : undefined,
        repo,
      }),
    );
    if (!result.taskId) throw new HttpError(409, result.message || "任务未入队", "config");
    return json({ ok: true, ...result, task: taskPayload(result.taskId) });
  }

  async function detail(id: string): Promise<Response> {
    const task = taskOr404(id);
    return json({
      ok: true,
      task: taskJson(task, now()),
      effects: store.effectsOf(task.id).map((e) => ({ kind: e.kind, target: e.target, detail: e.detail, createdAt: e.createdAt })),
      logTail: tailLog(cfg, task.id),
    });
  }

  async function action(req: Request, id: string, kind: string, url: URL): Promise<Response> {
    if (kind === "logs") {
      taskOr404(id);
      const count = Math.min(2000, Math.max(1, Number(url.searchParams.get("tail")) || 80));
      return json({ ok: true, id, lines: tailLog(cfg, id, count) });
    }
    const body = await readJson(req);
    const task = taskOr404(id);

    if (kind === "continue") {
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) throw new HttpError(400, "续跑需要新要求（prompt）");
      if (!task.branch) throw new HttpError(409, `任务 ${task.id} 没有可续跑的分支`, "state");
      const result = await dispatch(message(`${cfg.trigger} continue ${task.id} ${prompt}`));
      if (!result.taskId) throw new HttpError(409, result.message || "续跑未入队", "state");
      return json({ ok: true, ...result, task: taskPayload(result.taskId) });
    }

    if (kind === "retry") {
      const result = await dispatch(message(`${cfg.trigger} retry ${task.id}`));
      if (!result.taskId || result.taskId === task.id) {
        throw new HttpError(409, result.message || `任务 ${task.id} 无法重试`, task.status === "failed" || task.status === "cancelled" ? "component" : "state");
      }
      return json({ ok: true, ...result, task: taskPayload(result.taskId) });
    }

    if (kind === "merge" && body.confirm !== true) {
      throw new HttpError(400, "合并需要二次确认（confirm: true）");
    }
    const force = kind === "merge" && body.force === true ? " --force" : "";
    const yes = kind === "rewind" && body.yes === true ? " --yes" : "";
    const result = await dispatch(message(`${cfg.trigger} ${kind} ${task.id}${force}${yes}`));

    // 撤销预览不改状态：拿到回执即成功
    if (kind === "rewind" && body.yes !== true) return json({ ok: true, id, status: task.status, message: result.message });
    return verdict(id, kind, result.message);
  }

  async function executorAction(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (typeof body.paused !== "boolean") throw new HttpError(400, "需要 paused 布尔值");
    if (body.paused) router.pause();
    else router.resume();
    return json({ ok: true, executor: executor() });
  }

  return async (req: Request, url: URL): Promise<Response> => {
    const path = url.pathname;
    const method = req.method;

    if (path === "/api/state") {
      if (method !== "GET") return json({ ok: false, error: "方法不支持", reason: "config" }, 405, { allow: "GET" });
      return state();
    }
    if (path === "/api/board") {
      if (method !== "GET") return json({ ok: false, error: "方法不支持", reason: "config" }, 405, { allow: "GET" });
      return board(url);
    }
    if (path === "/api/executor/pause") {
      if (method !== "POST") return json({ ok: false, error: "方法不支持", reason: "config" }, 405, { allow: "POST" });
      return executorAction(req);
    }
    if (path === "/api/tasks") {
      if (method === "GET") return tasks(url);
      if (method === "POST") return submit(req);
      return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET, POST" });
    }

    const match = TASK_ROUTE.exec(path);
    if (!match) throw new HttpError(404, "未找到");
    const [, id, kind] = match;
    if (!kind) {
      if (method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
      return detail(id as string);
    }
    if (kind === "logs" ? method !== "GET" : method !== "POST") {
      return json({ ok: false, error: "方法不支持" }, 405, { allow: kind === "logs" ? "GET" : "POST" });
    }
    return action(req, id as string, kind, url);
  };
}
