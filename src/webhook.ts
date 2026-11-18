import { parseCapabilitySpec } from "./capabilities";
import { HttpError, MAX_BODY_BYTES, readJson, safeEqual } from "./http";
import type { IncomingMessage } from "./types";

/**
 * events 表跨通道共享，命名空间就是权限边界：
 * `webhook` 只能占自己的键，`cron:` / `github:comment:` / `telegram:` 归各自入口。
 */
export const WEBHOOK_EVENT_PREFIX = "webhook:";

export interface WebhookDeps {
  token: string;
  chatId: string;
  userId: string;
  handle: (msg: IncomingMessage) => Promise<void>;
  now?: () => number;
}

function text(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * `POST /event`：鉴权、正文上限与事件号命名空间都在进 Router 之前校验，
 * 被拒的请求不解析正文、不占 events 键。
 */
export function webhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  return async (req) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!safeEqual(req.headers.get("x-pisa-token") ?? "", deps.token)) {
      return new Response("forbidden", { status: 403 });
    }
    // 头部声明的长度先挡一道，不把大正文读进内存
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return new Response("payload too large", { status: 413 });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return new Response(err.status === 413 ? "payload too large" : "bad json", { status: err.status });
    }
    const prompt = text(body, "prompt");
    if (!prompt) return new Response("prompt required", { status: 400 });
    const given = body["eventId"];
    if (given !== undefined && (typeof given !== "string" || !given.startsWith(WEBHOOK_EVENT_PREFIX))) {
      return new Response(`eventId must start with ${WEBHOOK_EVENT_PREFIX}`, { status: 400 });
    }
    const eventId =
      (given as string | undefined) ?? `${WEBHOOK_EVENT_PREFIX}${now()}:${Math.random().toString(36).slice(2, 8)}`;
    await deps.handle({
      eventId,
      channel: "webhook",
      chatId: deps.chatId,
      userId: deps.userId,
      text: prompt,
      repo: text(body, "repo"),
      isDirect: true,
      threadKey: text(body, "threadKey"),
      version: text(body, "version"),
      capabilities: parseCapabilitySpec(body.capabilities) ?? undefined,
    });
    return Response.json({ ok: true, eventId });
  };
}
