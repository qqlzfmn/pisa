import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { DEFAULT_WEB, resolveConfigPath, type Config, type WebConfig } from "./config";
import type { Store } from "./store";
import type { ChannelAdapter, DeliveryReceipt, IncomingMessage, Task, TaskStatus } from "./types";
import { daemonState, formatStatusBoard, taskJson, type TaskJson } from "./status";
import { computeWindowMetrics, metricHistory, METRICS_WINDOW_MS, windowMetrics } from "./metrics";
import { readTail, tailLines } from "./log";
import { AuditLog, type AuditEntry } from "./audit";
import { editableConfig, saveConfigPatch, validateConfigPatch } from "./config-edit";
import { formatRewindPlan, formatRewindResult, type RewindExecution, type RewindPlan, type RewindPreviewResult } from "./rewind";
import { WEB_UI } from "./web-ui";
import { HttpError, readJson, safeEqual } from "./http";
import { WebSession } from "./web-session";

/** cookie 名；页面用 `?token=` 打开后由服务端下发，之后每次请求自动带上 */
export const WEB_COOKIE = "pisa_web";
/** 详情面板展示的日志行数 */
const LOG_TAIL_LINES = 200;
/** 日志尾部行数上限，CLI 的 --tail 也受它约束 */
const LOG_TAIL_MAX = 2000;
const TASK_ROUTE = /^\/api\/tasks\/([\w-]+)(?:\/(cancel|merge|rewind|retry))?$/;
/** 趋势图默认看 24 小时，最多一周 */
const METRICS_HOURS_MAX = 168;

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
  /** 配置文件路径；缺省按 resolveConfigPath() 解析，与进程启动时加载的是同一份 */
  configPath?: string;
  /** 审计日志；缺省写到 cfg.stateDir/audit.log */
  audit?: AuditLog;
}

/** Web 依赖 Router 的能力；Router 结构化满足它 */
export interface WebRouter {
  handle(msg: IncomingMessage): Promise<void>;
  rewindPreview(id: string): RewindPreviewResult;
  rewindExecute(plan: RewindPlan): RewindExecution;
  /** 执行器当前是否暂停；暂停只影响新任务的领取 */
  readonly executorPaused: boolean;
  pauseExecutor(): boolean;
  resumeExecutor(): boolean;
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

function tailLog(cfg: Config, id: string, lines = LOG_TAIL_LINES): string[] {
  const path = join(cfg.stateDir, "logs", `${id}.log`);
  if (!existsSync(path)) return [];
  return tailLines(readTail(path), lines).map((line) => {
    try {
      const rec = JSON.parse(line) as { ts?: number; stage?: string; msg?: string };
      const time = typeof rec.ts === "number" ? new Date(rec.ts).toTimeString().slice(0, 8) : "-";
      return `${time} ${rec.stage ?? "-"} ${rec.msg ?? ""}`.trimEnd();
    } catch {
      return line;
    }
  });
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
  const configFile = deps.configPath ?? resolveConfigPath();
  const audit = deps.audit ?? new AuditLog(cfg.stateDir);
  const session = new WebSession({ cfg, web, store, router, bus, audit });

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
    // ?token= 只用于首次打开页面：API 一律走请求头或 cookie，避免 token 落进日志与历史
    if (credential.fromQuery && url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "API 不接受 query token，请用 Authorization 或 x-pisa-token 请求头" }, 401, { "www-authenticate": "Bearer" });
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

    if (url.pathname === "/api/metrics") {
      if (req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
      const rawHours = Number(url.searchParams.get("hours") ?? 24);
      const hours = Number.isFinite(rawHours) ? Math.min(METRICS_HOURS_MAX, Math.max(1, Math.floor(rawHours))) : 24;
      const at = now();
      // 起点早于第一个桶，跨窗口仍在进行的任务才不会被漏掉
      const tasks = store.tasksInWindow(at - hours * 60 * 60 * 1000, at);
      return json({ ok: true, hours, ...metricHistory(tasks, at, hours) }, 200, setCookie);
    }

    if (url.pathname === "/api/config") {
      if (req.method === "GET") return json({ ok: true, ...editableConfig(configFile) }, 200, setCookie);
      if (req.method === "POST") {
        const body = await readJson(req);
        if (body.confirm !== true) throw new HttpError(400, "保存配置需要二次确认（confirm: true）");
        const checked = validateConfigPatch(body.patch);
        if (!checked.ok) {
          session.record("config.save", configFile, false, checked.errors.join("；").slice(0, 400));
          return json({ ok: false, error: checked.errors[0], errors: checked.errors }, 400, setCookie);
        }
        try {
          saveConfigPatch(configFile, checked.patch);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          session.record("config.save", configFile, false, reason);
          throw new HttpError(500, `写入配置失败：${reason}`);
        }
        const { patch } = checked;
        session.record(
          "config.save",
          configFile,
          true,
          `repos=${patch.repos.length} concurrency=${patch.worker.concurrency} timeoutSec=${patch.worker.timeoutSec} schedules=${patch.schedules.length}`,
        );
        return json(
          {
            ok: true,
            saved: true,
            path: configFile,
            restartRequired: true,
            message: `已保存 ${configFile}，重启 pisa 后生效`,
          },
          200,
          setCookie,
        );
      }
      return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET, POST" });
    }

    if (url.pathname === "/api/audit") {
      if (req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
      const rawLimit = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50;
      return json({ ok: true, file: audit.file, entries: audit.recent(limit) }, 200, setCookie);
    }

    if (url.pathname === "/api/state") {
      if (req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
      const at = now();
      const counts = store.countByStatus();
      return json({
        ok: true,
        daemon: daemonState(store, at),
        counts,
        total: Object.values(counts).reduce((sum, n) => sum + n, 0),
        last24h: windowMetrics(store, at),
        worker: {
          concurrency: Math.max(1, cfg.worker.concurrency ?? 1),
          running: counts.running,
          paused: router.executorPaused,
        },
        repos: cfg.repos.map((r) => r.alias),
        // 看板由服务端渲染：CLI 与 Web 共用同一套排版，客户端不再实现一份
        text: formatStatusBoard(store, at),
      });
    }

    if (url.pathname === "/api/repos") {
      if (req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
      return json({
        ok: true,
        repos: cfg.repos.map((r) => ({
          alias: r.alias,
          path: r.path,
          remote: r.remote ?? null,
          baseBranch: r.baseBranch ?? null,
          allowed: cfg.whitelist.repos.length === 0 || cfg.whitelist.repos.includes(r.alias),
        })),
      });
    }

    if (url.pathname === "/api/executor/pause") {
      if (req.method !== "POST") return json({ ok: false, error: "方法不支持" }, 405, { allow: "POST" });
      const body = await readJson(req);
      if (body.confirm !== true) throw new HttpError(400, "暂停/恢复执行器需要二次确认（confirm: true）");
      const paused = body.paused === false ? router.resumeExecutor() : router.pauseExecutor();
      session.record(paused ? "executor.pause" : "executor.resume", "executor", true, null);
      return json({
        ok: true,
        paused,
        message: paused ? "执行器已暂停：不再领取新任务，运行中的任务照常结束。" : "执行器已恢复：排队任务会立即被领取。",
      });
    }

    if (url.pathname === "/api/tasks") {
      if (req.method === "GET") {
        const repo = url.searchParams.get("repo") || undefined;
        const status = url.searchParams.get("status") || undefined;
        if (status && STATUS_LABEL[status] === undefined) {
          return json({ ok: false, error: `未知状态：${status}` }, 400);
        }
        const pr = Number(url.searchParams.get("pr") ?? NaN);
        const rawLimit = Number(url.searchParams.get("limit") ?? NaN);
        const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 20;
        const at = now();
        const daemon = daemonState(store, at);
        const tasks = Number.isFinite(pr)
          ? store.tasksByPr(pr, url.searchParams.get("githubRepo") || undefined, limit)
          : store.listTasks({ repo, status: status as TaskStatus | undefined, limit });
        return json(
          {
            ok: true,
            daemon,
            counts: store.countByStatus(),
            repos: cfg.repos.map((r) => r.alias),
            repo: repo ?? null,
            tasks: tasks.map((t) => boardTask(t, at)),
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
        if (body.confirm !== true) throw new HttpError(400, "派活需要二次确认（confirm: true）");
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) throw new HttpError(400, "任务内容不能为空");
        const repo = typeof body.repo === "string" && body.repo.trim() ? body.repo.trim() : undefined;
        const result = await session.dispatchTask(repo, prompt);
        session.record("dispatch", result.taskId || "-", result.ok, session.previewPrompt(prompt));
        return json({ ...result, taskId: result.taskId || null }, result.ok ? 200 : 400, setCookie);
      }
      return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET, POST" });
    }

    const match = TASK_ROUTE.exec(url.pathname);
    if (match) {
      const [, rawId, action] = match;
      const id = rawId as string;

      if (!action) {
        if (req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
        const task = store.get(id);
        if (!task) return json({ ok: false, error: "找不到任务" }, 404, setCookie);
        const at = now();
        const rawTail = Number(url.searchParams.get("tail") ?? NaN);
        const tail = Number.isFinite(rawTail) ? Math.min(LOG_TAIL_MAX, Math.max(1, Math.floor(rawTail))) : LOG_TAIL_LINES;
        return json(
          {
            ok: true,
            task: boardTask(task, at),
            effects: store.effectsOf(task.id).map((e) => ({ kind: e.kind, target: e.target, detail: e.detail, createdAt: e.createdAt })),
            logTail: tailLog(cfg, task.id, tail),
          },
          200,
          setCookie,
        );
      }

      if (action === "rewind") {
        if (req.method !== "GET" && req.method !== "POST") {
          return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET, POST" });
        }
        if (req.method === "POST") {
          const body = await readJson(req);
          if (body.confirm !== true) throw new HttpError(400, "撤销需要二次确认（confirm: true）");
        }
        const preview = router.rewindPreview(id);
        if (!preview.ok) {
          // 预览是只读动作，只在真正执行时留痕
          if (req.method === "POST") session.record("rewind", id, false, preview.error);
          return json({ ok: false, error: preview.error }, 409, setCookie);
        }
        if (req.method === "GET") {
          return json(
            {
              ok: true,
              merge: preview.plan.merge,
              actions: preview.plan.actions.map((a) => ({ kind: a.kind, label: a.label })),
              irreversible: preview.plan.irreversible,
              notes: preview.plan.notes,
              text: formatRewindPlan(preview.plan, cfg.trigger),
            },
            200,
            setCookie,
          );
        }
        // 撤销要删分支、推远端，和其它写操作一样独占
        const exec = await session.serialize(async () => router.rewindExecute(preview.plan));
        const failed = exec.results.filter((r) => !r.ok).length;
        session.record(
          "rewind",
          id,
          exec.rewound,
          exec.results.length === 0 ? "没有需要执行的撤销动作" : `${exec.results.length - failed}/${exec.results.length} 成功`,
        );
        const message =
          exec.results.length === 0
            ? exec.rewound
              ? "已标记撤销，没有需要执行的撤销动作。"
              : "未完成撤销：PR 状态无法确认。"
            : formatRewindResult(preview.plan, exec.results);
        return json(
          {
            ok: exec.rewound,
            status: store.get(id)?.status ?? null,
            results: exec.results.map((r) => ({ label: r.label, ok: r.ok, error: r.error ?? null })),
            message,
          },
          exec.rewound ? 200 : 409,
          setCookie,
        );
      }

      if (action === "retry") {
        if (req.method !== "POST") return json({ ok: false, error: "方法不支持" }, 405, { allow: "POST" });
        const body = await readJson(req);
        if (body.confirm !== true) throw new HttpError(400, "重试需要二次确认（confirm: true）");
        try {
          const retry = await session.retry(id);
          session.record("retry", id, true, retry.taskId);
          return json(retry, 200, setCookie);
        } catch (err) {
          if (err instanceof HttpError) {
            session.record("retry", id, false, err.message);
            return json({ ok: false, error: err.message }, err.status, setCookie);
          }
          throw err;
        }
      }

      if (req.method !== "POST") return json({ ok: false, error: "方法不支持" }, 405, { allow: "POST" });
      const body = await readJson(req);
      if (body.confirm !== true) {
        throw new HttpError(400, action === "merge" ? "合并需要二次确认（confirm: true）" : "取消需要二次确认（confirm: true）");
      }
      const kind = action as "cancel" | "merge";
      const result = await session.run(session.message(`${kind} ${id}`));
      const task = store.get(id);
      const done =
        kind === "cancel"
          ? Boolean(task && (task.status === "cancelled" || store.isCancelRequested(task.id)))
          : store.effectsOf(id).some((e) => e.kind === "merge");
      session.record(kind, id, result.ok && done, result.message.slice(0, 200));
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
