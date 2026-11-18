import { HttpError, readJson, safeEqual } from "./http";
import type { Manager } from "./manager";

/** 管理接口：GET /state、/tickets/:id；POST /tickets/:id/{stop,retry,merge,rewind}、/executor/{pause,resume} */
const TICKET_ROUTE = /^\/tickets\/([\w-]+)(?:\/(stop|retry|merge|rewind))?$/;
const EXECUTOR_ROUTE = /^\/executor\/(pause|resume)$/;

export interface ApiDeps {
  manager: Manager;
  /** 与 Web 控制台共用的 token */
  token: string;
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** 管理接口只认请求头：token 不落 URL 与 cookie，避免日志、进程列表与浏览器历史留痕 */
function headerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return req.headers.get("x-pisa-token");
}

/** 只服务本机：远端页面可以伪造 Host，但它发不到 127.0.0.1 之外，这里再挡一层 DNS rebinding */
function isLocalHost(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return true;
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

/**
 * 管理接口入口：命中管理路径才返回响应，其余交给 Web 控制台。
 * 鉴权失败、方法不支持、越权都在这里落成状态码；业务错误由 Manager 的 ActionReply 直接映射。
 */
export async function handleApi(req: Request, url: URL, deps: ApiDeps): Promise<Response | null> {
  const path = url.pathname;
  const ticket = TICKET_ROUTE.exec(path);
  const executor = EXECUTOR_ROUTE.exec(path);
  if (path !== "/state" && !ticket && !executor) return null;

  if (!isLocalHost(req)) return json({ ok: false, error: "只接受本机请求" }, 403);
  const token = headerToken(req);
  if (!token || !safeEqual(token, deps.token)) {
    return json({ ok: false, error: "未授权" }, 401, { "www-authenticate": "Bearer" });
  }

  if (path === "/state") {
    if (req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
    return json(deps.manager.state());
  }

  if (executor) {
    if (req.method !== "POST") return json({ ok: false, error: "方法不支持" }, 405, { allow: "POST" });
    const reply = deps.manager.setPaused(executor[1] === "pause");
    return json(reply.body, reply.status);
  }

  const id = ticket![1]!;
  const action = ticket![2];
  if (!action) {
    if (req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405, { allow: "GET" });
    const payload = deps.manager.ticket(id);
    if (!payload) return json({ ok: false, error: `找不到任务 ${id}` }, 404);
    return json({ ok: true, ...payload });
  }
  if (req.method !== "POST") return json({ ok: false, error: "方法不支持" }, 405, { allow: "POST" });

  let reply;
  if (action === "stop") reply = await deps.manager.stop(id);
  else if (action === "retry") reply = await deps.manager.retry(id);
  else if (action === "merge") {
    const body = await readJson(req);
    if (body.confirm !== true) throw new HttpError(400, "合并需要二次确认（confirm: true）");
    reply = await deps.manager.merge(id);
  } else {
    const body = await readJson(req);
    reply = await deps.manager.rewind(id, body.apply === true);
  }
  return json(reply.body, reply.status);
}
