import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** 常量时间比较两个十六进制摘要；长度不同直接判否，避免 timingSafeEqual 抛错 */
function digestEquals(a: string, b: string): boolean {
  const left = Buffer.from(a.toLowerCase(), "utf8");
  const right = Buffer.from(b.toLowerCase(), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** `X-Hub-Signature-256: sha256=<hex>` 与原始请求体比对 */
export function verifyGithubSignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header) return false;
  const prefix = "sha256=";
  if (!header.startsWith(prefix)) return false;
  return digestEquals(hmacSha256Hex(secret, body), header.slice(prefix.length));
}

/** 飞书 v2 签名：sha256(timestamp + nonce + encryptKey + body) */
export function verifyFeishuSignature(input: {
  body: string;
  timestamp: string | undefined;
  nonce: string | undefined;
  encryptKey: string;
  signature: string | undefined;
}): boolean {
  const { body, timestamp, nonce, encryptKey, signature } = input;
  if (!timestamp || !nonce || !signature) return false;
  return digestEquals(sha256Hex(`${timestamp}${nonce}${encryptKey}${body}`), signature);
}

/** 请求体必须是 JSON 对象；数组、标量和非法 JSON 一律视为非法载荷 */
export function parseJsonObject(body: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 按路径读嵌套字段，只认对象与字符串 */
export function str(value: unknown, ...path: string[]): string | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

/** 按路径读嵌套对象 */
export function obj(value: unknown, ...path: string[]): Record<string, unknown> | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
  return cursor as Record<string, unknown>;
}

/** 按路径读数字字段（JSON 数字），整数值才返回 */
export function num(value: unknown, ...path: string[]): number | undefined {
  let cursor: unknown = value;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : undefined;
}
