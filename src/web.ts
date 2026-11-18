import { randomBytes } from "node:crypto";
import type { Server } from "bun";
import { DEFAULT_WEB, type Config, type WebConfig } from "./config";
import type { Store } from "./store";
import { WEB_UI } from "./web-ui";
import { HttpError, json, reasonFor, safeEqual } from "./http";
import { daemonState } from "./status";
import { computeWindowMetrics, METRICS_WINDOW_MS } from "./metrics";
import { createApi, type ApiRouter } from "./api";
import type { ReplyBus } from "./channels/reply-bus";

/** cookie 名；页面用 `?token=` 打开后由服务端下发，之后每次请求自动带上 */
export const WEB_COOKIE = "pisa_web";

export interface WebDeps {
  cfg: Config;
  store: Store;
  /** 管理接口只依赖 Router 的管理能力；Router 结构化满足它 */
  router: ApiRouter;
  bus: ReplyBus;
  /** 已解析的访问 token */
  token: string;
  now?: () => number;
  /** 进程启动时间（毫秒）；缺省取创建 Web 应用的时刻，作为 /health 的 uptime 起点 */
  startedAt?: number;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * 请求携带的 token：Bearer、专用头、cookie 任选；
 * 只有页面打开时才允许 `?token=`——接口调用走查询参数会把凭证留进进程列表与日志。
 */
function requestToken(req: Request, url: URL, allowQuery: boolean): { token: string; fromQuery: boolean } | null {
  const query = allowQuery ? url.searchParams.get("token") : null;
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
 * 本机控制面：`/api/*` 全部交给管理接口，这里只做鉴权、页面外壳与健康快照。
 * 返回纯函数，测试用 `new Request(...)` 直接喂，不需要真实端口。
 */
export function createWebApp(deps: WebDeps): (req: Request, url?: URL) => Promise<Response> {
  const { cfg, store, token, bus } = deps;
  const web: WebConfig = cfg.web ?? { ...DEFAULT_WEB, enabled: true };
  const now = deps.now ?? Date.now;
  const startedAt = deps.startedAt ?? now();
  const control = createApi({ cfg, store, router: deps.router, bus, now });

  /**
   * 健康快照：只给本机监控用，不上鉴权（不含任务正文），
   * 但要求服务只监听 127.0.0.1；ok 取守护进程心跳，心跳停了即使 HTTP 还能应答也算不健康。
   */
  function health(): Response {
    const at = now();
    const daemon = daemonState(store, at);
    const counts = store.countByStatus();
    const finished = store.finishedBetween(at - METRICS_WINDOW_MS, at);
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
        last24h: computeWindowMetrics(finished),
        repos: [...perRepo].map(([repo, c]) => ({ repo, ...c })),
        daemon,
      },
      daemon.alive ? 200 : 503,
    );
  }

  async function route(req: Request, url: URL): Promise<Response> {
    if (url.pathname === "/health") {
      if (req.method !== "GET") return json({ ok: false, error: "方法不支持", reason: "config" }, 405, { allow: "GET" });
      return health();
    }

    const isApi = url.pathname.startsWith("/api/");
    const credential = requestToken(req, url, !isApi);
    if (!credential || !safeEqual(credential.token, token)) {
      return json({ ok: false, error: "未授权", reason: "auth" }, 401, { "www-authenticate": "Bearer" });
    }
    if (isApi) return control(req, url);

    const setCookie: Record<string, string> = credential.fromQuery
      ? { "set-cookie": `${WEB_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/` }
      : {};
    if (req.method === "GET" && url.pathname === "/ui") {
      if (!web.enabled) return json({ ok: false, error: "Web 控制台未启用（web.enabled）", reason: "config" }, 404);
      return new Response(WEB_UI, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...setCookie },
      });
    }
    if (req.method === "GET" && url.pathname === "/") {
      if (!web.enabled) return json({ ok: false, error: "Web 控制台未启用（web.enabled）", reason: "config" }, 404);
      const query = credential.fromQuery ? `?token=${encodeURIComponent(credential.token)}` : "";
      return new Response(null, { status: 302, headers: { location: `/ui${query}` } });
    }
    return json({ ok: false, error: "未找到", reason: "not_found" }, 404);
  }

  return async (req: Request, url = new URL(req.url)): Promise<Response> => {
    try {
      return await route(req, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ ok: false, error: err.message, reason: err.reason }, err.status);
      return json({ ok: false, error: err instanceof Error ? err.message : String(err), reason: reasonFor(500) }, 500);
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

/** 只监听 127.0.0.1：控制面是操作本机的工具，不暴露到网络 */
export function startWebServer(deps: Omit<WebDeps, "token">, web: WebConfig): WebServer {
  const { token, ephemeral } = resolveToken(web);
  const handle = createWebApp({ ...deps, token });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: web.port,
    // 合并要跑测试再快进，不能让空闲连接在验证中途被掐断
    idleTimeout: 255,
    fetch: (req: Request) => handle(req),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const url = `${base}/api/state`;
  if (ephemeral) console.log(`控制面 token 未配置（${web.tokenEnv}），本次使用一次性 token：${token}`);
  console.log(`控制面：${base}（接口 /api/state，页面${web.enabled ? ` /ui?token=${encodeURIComponent(token)}` : "未启用"}）`);
  return { server, url, token, stop: async () => void (await server.stop(true)) };
}
