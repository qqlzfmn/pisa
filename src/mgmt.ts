import type { Config } from "./config";
import { mgmtSettings } from "./config";
import { readTaskLog } from "./log";
import type { Router } from "./router";
import type { Store } from "./store";

export interface MgmtDeps {
  cfg: Config;
  store: Store;
  router: Router;
  token: string;
}

export interface MgmtServer {
  url: string;
  stop(): void;
}

const TOKEN_HEADER = "x-pisa-token";
/** 只接受回环来源：URL 主机名落在这些值才继续 */
const LOOPBACK: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true, "::1": true };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, reason: string): Response {
  return json({ error: reason }, status);
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = (await req.json()) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 本地管理接口。顺序固定：回环校验 → token → 路由，任一步失败都不读 store。
 * 调用方（pisa CLI、脚本、agent）只依赖这里的 HTTP 契约，不碰 SQLite。
 */
export function createMgmtHandler(deps: MgmtDeps): (req: Request) => Promise<Response> {
  const { store, router } = deps;

  return async (req) => {
    const url = new URL(req.url);
    if (!Object.hasOwn(LOOPBACK, url.hostname)) return fail(403, "只接受本机请求");
    if (req.headers.get(TOKEN_HEADER) !== deps.token) return fail(403, "token 不正确");

    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method;

    if (parts.length === 1 && parts[0] === "state") {
      if (method !== "GET") return fail(405, "只支持 GET");
      return json(router.state());
    }

    if (parts[0] === "executor" && parts.length === 2) {
      if (method !== "POST") return fail(405, "只支持 POST");
      if (parts[1] === "pause") {
        router.pause();
        return json({ paused: true });
      }
      if (parts[1] === "resume") {
        router.resume();
        return json({ paused: false });
      }
      return fail(404, "未知的 executor 操作");
    }

    if (parts[0] !== "tickets") return fail(404, "未知路径");

    // POST /tickets 建单
    if (parts.length === 1) {
      if (method !== "POST") return fail(405, "只支持 POST");
      const body = await readJson(req);
      const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) return fail(400, "prompt 不能为空");
      const result = router.submitTicket({
        prompt,
        repo: typeof body?.repo === "string" ? body.repo : undefined,
        eventId: typeof body?.eventId === "string" ? body.eventId : undefined,
      });
      if (!result.ok) return fail(400, result.reason);
      return json({ ticket: result.task }, 201);
    }

    if (parts.length < 2) return fail(404, "缺少任务号");
    const id = decodeURIComponent(parts[1] ?? "");
    const ticket = store.get(id);

    // GET /tickets/:id
    if (parts.length === 2) {
      if (method !== "GET") return fail(405, "只支持 GET");
      if (!ticket) return fail(404, `找不到任务 ${id}`);
      return json({ ticket, effects: store.effectsOf(id) });
    }

    if (method !== "POST" && parts[2] !== "logs") return fail(405, "只支持 POST");

    if (parts[2] === "logs") {
      if (method !== "GET") return fail(405, "只支持 GET");
      if (!ticket) return fail(404, `找不到任务 ${id}`);
      return json({ entries: readTaskLog(deps.cfg.stateDir, id) });
    }

    switch (parts[2]) {
      case "retry": {
        if (!ticket) return fail(404, `找不到任务 ${id}`);
        const result = router.retryTicket(id);
        if (!result.ok) return fail(409, result.reason);
        return json({ ticket: result.task });
      }
      case "stop": {
        if (!ticket) return fail(404, `找不到任务 ${id}`);
        const result = router.stopTicket(id);
        if (!result.ok) return fail(409, result.reason);
        return json({ ticket: result.task, cancelling: result.cancelling });
      }
      case "merge": {
        if (!ticket) return fail(404, `找不到任务 ${id}`);
        const result = router.mergeTicket(id);
        if (!result.ok) return fail(409, result.text);
        return json({ ok: true, text: result.text, needsRestart: result.needsRestart });
      }
      case "rewind": {
        if (!ticket) return fail(404, `找不到任务 ${id}`);
        const body = await readJson(req);
        const result = router.rewindTicket(id, body?.yes === true);
        if (!result.ok) return fail(409, result.text);
        return json({ ok: true, text: result.text });
      }
      default:
        return fail(404, "未知的 tickets 操作");
    }
  };
}

/**
 * 启动管理服务；未启用或缺 token 时返回 null（由调用方打日志）。
 * 端口被占用等启动错误同样返回 null，不阻断主进程。
 */
export function startMgmtServer(cfg: Config, store: Store, router: Router): MgmtServer | null {
  const settings = mgmtSettings(cfg);
  if (!settings.enabled) return null;
  const token = process.env[settings.tokenEnv];
  if (!token) return null;

  try {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: settings.port,
      fetch: createMgmtHandler({ cfg, store, router, token }),
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
  } catch {
    return null;
  }
}
