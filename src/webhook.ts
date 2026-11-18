import type { Store } from "./store";
import type { IncomingMessage } from "./types";

export interface WebhookDeps {
  token: string;
  chatId: string;
  userId: string;
  store: Store;
  /** 交给 Router.handle；回执与任务行在这一步同步落库 */
  submit: (msg: IncomingMessage) => Promise<void>;
}

interface WebhookBody {
  prompt?: string;
  repo?: string;
  eventId?: string;
  threadKey?: string;
  version?: string;
}

/**
 * 事件入口：只接 127.0.0.1 的 `POST /event`。
 *
 * 回执直接给 `taskId`，调用方按它跟踪任务；`events` 行在响应之前写入，
 * 按 `eventId` 反查也不会落空——反查不到就重派的调用方会因此停下。
 */
export function createWebhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (req.headers.get("x-pisa-token") !== deps.token) return new Response("forbidden", { status: 403 });
    let body: WebhookBody;
    try {
      body = (await req.json()) as WebhookBody;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (!body.prompt) return new Response("prompt required", { status: 400 });

    const eventId = body.eventId ?? `webhook:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    // 调用方带业务单号就能跨入口命中同一个任务；缺省本条消息独立成线程
    const threadKey = body.threadKey ?? `webhook:${deps.chatId}:${eventId}`;
    await deps.submit({
      eventId,
      channel: "webhook",
      chatId: deps.chatId,
      userId: deps.userId,
      text: body.prompt,
      repo: body.repo,
      isDirect: true,
      threadKey,
      messageKey: eventId,
      version: body.version,
    });

    // 命令类投递（cancel/status/merge…）不建任务，taskId 为 null
    const taskId = deps.store.triggerByMessage(threadKey, eventId)?.taskId ?? null;
    if (taskId) deps.store.claimEvent(eventId, taskId);
    return Response.json({ ok: true, eventId, taskId });
  };
}
