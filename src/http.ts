import { timingSafeEqual } from "node:crypto";

/** 本机 HTTP 入口的请求体上限：派活正文、确认标志与事件号都很小 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 本机 HTTP 接口的统一 JSON 回包 */
export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** 入口错误：带 HTTP 状态码，调用方按 status 回包 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 常量时间比较；长度不等直接判否，timingSafeEqual 遇到不等长会抛错 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 读 JSON 对象正文；超过上限抛 413，空正文视为 {} */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new HttpError(413, "请求体过大");
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "请求体必须是 JSON 对象");
  return value as Record<string, unknown>;
}
