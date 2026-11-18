import { randomBytes } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { DEFAULT_WEB, type Config, type WebConfig } from "./config";
import type { Store } from "./store";
import type { ReplyBus } from "./reply-bus";
import { daemonState } from "./status";
import { computeWindowMetrics, METRICS_WINDOW_MS } from "./metrics";
import { WEB_UI } from "./web-ui";
import { HttpError, readJson, safeEqual } from "./http";
import { boardTask, Manager, type ManagerRouter } from "./manager";
import { handleApi } from "./api";

/** cookie 名；页面用 `?token=` 打开后由服务端下发，之后每次请求自动带上 */
export const WEB_COOKIE = "pisa_web";
const TASK_ROUTE = /^\/api\/tasks\/([\w-]+)(?:\/(cancel|merge))?$/;

export interface WebDeps {
  cfg: Config;
  store: Store;
  router: ManagerRouter;
  bus: ReplyBus;
  /** 已解析的访问 token */
  token: string;
  /** 是否提供浏览器控制台；管理接口始终可用 */
  ui?: boolean;
  now?: () => number;
  /** 进程启动时间（毫秒）；缺省取创建 Web 应用的时刻，作为 /health 的 uptime 起点 */
  startedAt?: number;
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

/** 浏览器的 token：查询参数、Bearer、专用头、cookie，任一命中即可 */
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

/**
 * 本机控制面 HTTP 外壳：管理接口与 Web 控制台共用一套鉴权与业务层，
 * 账本、状态机与校验都在 Manager/Router 里，这里只做路由与序列化。
 * 返回纯函数，测试用 `new Request(...)` 直接喂，不需要真实端口。
 */
export function createWebApp(deps: WebDeps): (req: Request) => Promise<Response> {
  const { cfg, store, token } = deps;
  const web: WebConfig = cfg.web ?? { ...DEFAULT_WEB, enabled: true, userId: "web" };
  const now = deps.now ?? Date.now;
  const startedAt = deps.startedAt ?? now();
  const ui = deps.ui ?? true;
  const manager = new Manager({ cfg, store, router: deps.router, bus: deps.bus, web, now });

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

    const api = await handleApi(req, url, { manager, token });
    if (api) return api;

    const credential = requestToken(req, url);
    if (!credential || !safeEqual(credential.token, token)) {
      return json({ ok: false, error: "未授权" }, 401, { "www-authenticate": "Bearer" });
    }
    const setCookie: Record<string, string> = credential.fromQuery
      ? { "set-cookie": `${WEB_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/` }
      : {};

    if (url.pathname === "/ui" || url.pathname === "/") {
      if (!ui) return json({ ok: false, error: "控制台未启用" }, 404);
      if (url.pathname === "/ui") {
        return new Response(WEB_UI, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...setCookie },
        });
      }
      return new Response(null, {
        status: 302,
        headers: { location: `/ui${credential.fromQuery ? `?token=${encodeURIComponent(credential.token)}` : ""}` },
      });
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
        const result = await manager.dispatchTask(repo, prompt);
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
        const payload = manager.ticket(id as string);
        if (!payload) return json({ ok: false, error: "找不到任务" }, 404, setCookie);
        return json({ ok: true, ...payload }, 200, setCookie);
      }

      const reply =
        action === "cancel"
          ? await manager.stop(id as string)
          : action === "merge"
            ? await (async () => {
                const body = await readJson(req);
                if (body.confirm !== true) throw new HttpError(400, "合并需要二次确认（confirm: true）");
                return manager.merge(id as string);
              })()
            : null;
      if (!reply) return json({ ok: false, error: "未找到" }, 404);
      return json(reply.body, reply.status, setCookie);
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
  const fromEnv = process.env.PISA_API_TOKEN?.trim() || process.env[web.tokenEnv]?.trim();
  if (fromEnv) return { token: fromEnv, ephemeral: false };
  return { token: randomBytes(16).toString("hex"), ephemeral: true };
}

export interface WebServer {
  server: Server<unknown>;
  /** 管理接口基址，供 CLI 与脚本使用 */
  apiUrl: string;
  /** 浏览器控制台地址；未启用时为空串 */
  uiUrl: string;
  token: string;
  stop: () => Promise<void>;
}

function listen(handle: (req: Request) => Promise<Response>, port: number): Server<unknown> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    // 合并要跑测试再快进，不能让空闲连接在验证中途被掐断
    idleTimeout: 255,
    fetch: handle,
  });
}

function portInUse(err: unknown): boolean {
  return (err as { code?: string }).code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(String(err));
}

/**
 * 控制面服务：始终监听 127.0.0.1，管理接口与（可选）浏览器控制台同一端口。
 * 端口被别的程序占着时：控制台没开就退回系统分配（地址仍写进 api.json）；
 * 控制台开着则直接报错，因为用户预期的页面地址会变。
 */
export function startWebServer(deps: Omit<WebDeps, "token">, web: WebConfig): WebServer {
  const { token, ephemeral } = resolveToken(web);
  const handle = createWebApp({ ...deps, token, ui: web.enabled });
  let server: Server<unknown>;
  try {
    server = listen(handle, web.port);
  } catch (err) {
    if (!web.enabled && portInUse(err)) {
      console.warn(`[pisa] 端口 ${web.port} 被占用，管理接口改用系统分配端口`);
      server = listen(handle, 0);
    } else if (web.enabled && portInUse(err)) {
      throw new Error(`Web 控制台端口 ${web.port} 被占用；改用其它端口或关闭 web.enabled`);
    } else {
      throw err;
    }
  }
  const apiUrl = `http://127.0.0.1:${server.port}`;
  const file = join(deps.cfg.stateDir, "api.json");
  writeFileSync(file, `${JSON.stringify({ url: apiUrl, token, pid: process.pid }, null, 2)}\n`, { mode: 0o600 });
  const uiUrl = web.enabled ? `${apiUrl}/ui${ephemeral ? `?token=${encodeURIComponent(token)}` : ""}` : "";
  if (web.enabled) {
    console.log(ephemeral ? `Web 控制台 token 未配置，本次使用一次性 token：${uiUrl}` : `Web 控制台：${uiUrl}`);
  }
  console.log(`[pisa] 管理接口 ${apiUrl} · token ${ephemeral ? "一次性" : `来自 ${web.tokenEnv} 或 PISA_API_TOKEN`}`);
  return {
    server,
    apiUrl,
    uiUrl,
    token,
    stop: async () => {
      rmSync(file, { force: true });
      await server.stop(true);
    },
  };
}
