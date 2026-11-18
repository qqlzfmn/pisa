import { timingSafeEqual } from "node:crypto";

/** 本机 HTTP 入口的请求体上限：派活正文、确认标志与事件号都很小 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 错误归类：CLI 只按 reason 决定退出码，不解析中文正文 */
export type ErrorReason = "auth" | "config" | "state" | "not_found" | "component";

export function reasonFor(status: number): ErrorReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status >= 500) return "component";
  if (status === 409) return "state";
  return "config";
}

/** 入口错误：带 HTTP 状态码与归类，调用方按 status 回包、按 reason 分支 */
export class HttpError extends Error {
  readonly reason: ErrorReason;

  constructor(
    readonly status: number,
    message: string,
    reason?: ErrorReason,
  ) {
    super(message);
    this.reason = reason ?? reasonFor(status);
  }
}

/** JSON 响应；控制面一律不缓存，避免看板读到旧状态 */
export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
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
