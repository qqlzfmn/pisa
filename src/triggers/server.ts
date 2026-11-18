import type { Server } from "bun";
import type { IncomingMessage } from "../types";
import type { TriggerAdapter, TriggerReply, TriggerRequest } from "./types";
import { jsonReply } from "./util";

/** 事件回调都很小；超过这个体积直接拒绝，避免本地端口被大包拖住 */
const MAX_BODY_BYTES = 256 * 1024;

export interface TriggerHandlerDeps {
  adapters: TriggerAdapter[];
  /** 事件正文没有被适配器处理掉触发词时补上 */
  trigger: string;
  handle: (message: IncomingMessage) => Promise<unknown> | unknown;
  now?: () => number;
}

/**
 * `/triggers/<name>` 是唯一入口：路由、限流、verify/normalize 在这里，
 * 去重与状态机仍在 Router（store.claimEvent），适配器保持无状态。
 */
export function createTriggerHandler(deps: TriggerHandlerDeps): (req: Request) => Promise<Response> {
  const routes = new Map(deps.adapters.map((adapter) => [`/triggers/${adapter.name}`, adapter]));
  return async (req) => {
    const url = new URL(req.url);
    const adapter = routes.get(url.pathname);
    if (!adapter) return fail(404, "未知触发器");

    const body = await readBody(req);
    if (body === null) return fail(413, "请求体超过 256 KiB");
    const request: TriggerRequest = {
      method: req.method.toUpperCase(),
      url,
      headers: req.headers,
      body,
    };

    const verdict = adapter.verify(request);
    if (!verdict.ok) return fail(verdict.status, verdict.reason);

    const outcome = adapter.normalize(request);
    switch (outcome.kind) {
      case "reply":
        return respond(outcome.reply);
      case "ignore":
        return respond(jsonReply(200, { ok: true, ignored: outcome.reason }));
      case "reject":
        return fail(outcome.status, outcome.reason);
      case "event": {
        const payload = outcome.payload;
        const text =
          payload.text === deps.trigger || payload.text.startsWith(`${deps.trigger} `)
            ? payload.text
            : `${deps.trigger} ${payload.text}`;
        const eventId = adapter.dedupeKey(payload);
        const message: IncomingMessage = {
          eventId,
          channel: adapter.name,
          chatId: payload.chatId,
          userId: payload.userId,
          text,
          isDirect: true,
          receivedAt: deps.now?.() ?? Date.now(),
        };
        if (payload.repo) message.repo = payload.repo;
        await deps.handle(message);
        if (outcome.ack) return respond(outcome.ack);
        return respond(jsonReply(202, { ok: true, eventId }));
      }
    }
  };
}

export interface TriggerServer {
  server: Server<unknown>;
  url: string;
  stop: () => Promise<void>;
}

/** 只绑回环地址；对外暴露由反向代理负责 */
export function startTriggerServer(deps: TriggerHandlerDeps, port: number): TriggerServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 30,
    fetch: createTriggerHandler(deps),
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}

function respond(reply: TriggerReply): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  if (reply.contentType) headers.set("content-type", reply.contentType);
  return new Response(reply.body ?? "", { status: reply.status, headers });
}

function fail(status: number, error: string): Response {
  return respond(jsonReply(status, { ok: false, error }));
}

/** 按流读取并截断；Content-Length 不可信时也不会把整包读进内存 */
async function readBody(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}
