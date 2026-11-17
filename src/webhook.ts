import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "./types";

/** 请求体上限：webhook 只投递一句需求，超大请求直接拒绝 */
const MAX_BODY_BYTES = 64 * 1024;

/** 事件命名空间：去重表跨通道共享，每个通道只能占用自己的前缀 */
const EVENT_PREFIX = "webhook:";

export interface WebhookDeps {
  /** 期望的 `x-pisa-token` */
  token: string;
  /** 投递任务的会话与请求者身份 */
  chatId: string;
  userId: string;
  handle(msg: IncomingMessage): Promise<void>;
  now?: () => number;
}

interface EventBody {
  prompt: string;
  repo?: string;
  eventId?: string;
}

type ParseResult = { ok: true; body: EventBody } | { ok: false; message: string };

/** 外部 JSON 的运行时校验：类型不对直接拒绝，不做断言 */
function parseBody(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, message: "bad json" };
  const fields = raw as Record<string, unknown>;
  const { prompt, repo, eventId } = fields;
  if (typeof prompt !== "string" || prompt === "") return { ok: false, message: "prompt required" };
  if (repo !== undefined && typeof repo !== "string") return { ok: false, message: "repo must be a string" };
  if (eventId !== undefined && typeof eventId !== "string") return { ok: false, message: "eventId must be a string" };
  if (typeof eventId === "string" && !eventId.startsWith(EVENT_PREFIX)) {
    return { ok: false, message: `eventId must start with ${EVENT_PREFIX}` };
  }
  return { ok: true, body: { prompt, repo, eventId } };
}

/** 常量时间比较；长度不等直接不匹配，不进入 timingSafeEqual */
function tokenMatches(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 声明的长度；缺失或非法按 0 处理，实际字节数还有一次兜底 */
function declaredLength(req: Request): number {
  const raw = req.headers.get("content-length");
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function webhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  return async (req) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    // 先鉴权再读 body：未授权请求不消耗内存
    if (!tokenMatches(req.headers.get("x-pisa-token"), deps.token)) return new Response("forbidden", { status: 403 });
    if (declaredLength(req) > MAX_BODY_BYTES) return new Response("payload too large", { status: 413 });

    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > MAX_BODY_BYTES) return new Response("payload too large", { status: 413 });

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const result = parseBody(parsed);
    if (!result.ok) return new Response(result.message, { status: 400 });

    const eventId = result.body.eventId ?? `webhook:${now()}:${Math.random().toString(36).slice(2, 8)}`;
    await deps.handle({
      eventId,
      channel: "webhook",
      chatId: deps.chatId,
      userId: deps.userId,
      text: result.body.prompt,
      repo: result.body.repo,
      isDirect: true,
    });
    return Response.json({ ok: true, eventId });
  };
}
