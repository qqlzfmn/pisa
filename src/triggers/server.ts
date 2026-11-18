import type { Config } from "../config";
import type { IncomingMessage } from "../types";
import type { TriggerAdapter, TriggerEvent, TriggerRequest } from "./types";

const ROUTE = /^\/triggers\/([A-Za-z0-9-]+)\/?$/;

export interface TriggerHandlerDeps {
  cfg: Config;
  adapters: TriggerAdapter[];
  /** 事件归一化后的收口：通常直接是 `router.handle` */
  handle: (msg: IncomingMessage) => Promise<void> | void;
}

/** `fetch` 形态的入口：一个适配器一个路径，验签 → 归一化 → 交给 core */
export function createTriggerHandler(deps: TriggerHandlerDeps): (req: Request) => Promise<Response> {
  const byName = new Map(deps.adapters.map((adapter) => [adapter.name, adapter]));
  return async (req) => {
    if (!deps.cfg.triggers) return json({ ok: false, error: "触发器未启用" }, 404);
    const url = new URL(req.url);
    const matched = ROUTE.exec(url.pathname);
    if (!matched) return json({ ok: false, error: "未找到" }, 404);
    const name = matched[1]!;
    const adapter = byName.get(name);
    if (!adapter) return json({ ok: false, error: `未启用的触发器：${name}` }, 404);
    if (req.method !== "POST" && req.method !== "GET") return json({ ok: false, error: "方法不支持" }, 405);

    const raw: TriggerRequest = {
      method: req.method,
      headers: req.headers,
      query: url.searchParams,
      // 验签必须按原始字节算，读取后不再解析
      body: await req.text(),
    };
    const bad = adapter.verify(raw);
    if (bad) return json({ ok: false, error: bad }, 401);

    const outcome = adapter.normalize(raw);
    switch (outcome.kind) {
      case "challenge":
        return new Response(outcome.body, {
          status: 200,
          headers: { "content-type": outcome.contentType ?? "text/plain; charset=utf-8" },
        });
      case "ignore":
        return json({ ok: true, ignored: outcome.reason });
      case "reject":
        return json({ ok: false, error: outcome.reason }, outcome.status);
      case "event": {
        const id = adapter.dedupeKey(outcome.event);
        await deps.handle(messageOf(deps.cfg, adapter, outcome.event, id, outcome.repo));
        return json({ ok: true, id });
      }
    }
  };
}

export interface TriggerServer {
  stop: () => void;
}

export function startTriggerServer(deps: TriggerHandlerDeps & { port: number }): TriggerServer {
  const server = Bun.serve({
    port: deps.port,
    hostname: "127.0.0.1",
    fetch: createTriggerHandler(deps),
    error: () => json({ ok: false, error: "内部错误" }, 500),
  });
  return { stop: () => server.stop(true) };
}

/**
 * 事件 → core 的消息：线程、消息版本、触发者取自事件；
 * 任务的归属身份与命令前缀由配置补齐，正文原样下发。
 */
function messageOf(
  cfg: Config,
  adapter: TriggerAdapter,
  event: TriggerEvent,
  id: string,
  repo: string | undefined,
): IncomingMessage {
  const entry = cfg.triggers!;
  const text = event.text.trim();
  return {
    eventId: `trigger:${adapter.name}:${id}`,
    channel: adapter.name,
    chatId: entry.chatId,
    userId: entry.userId,
    actor: event.actor,
    repo: repo ?? entry.repo,
    isDirect: true,
    // 验签已由适配器完成，等价于入口侧鉴权
    admin: true,
    text: text.startsWith(cfg.trigger) ? text : `${cfg.trigger} ${text}`,
    threadKey: event.threadKey,
    messageKey: event.messageKey,
    version: event.version,
    receivedAt: event.at,
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
