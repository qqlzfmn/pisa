import { timingSafeEqual } from "node:crypto";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空字符串；数字与布尔返回 undefined，避免把 id 当正文 */
export function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 常量时间字符串比较；长度不同直接失败，不泄露前缀匹配长度 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function jsonReply(status: number, value: unknown): { status: number; body: string; contentType: string } {
  return { status, body: JSON.stringify(value), contentType: "application/json; charset=utf-8" };
}
