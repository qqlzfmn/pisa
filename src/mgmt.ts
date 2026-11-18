import type { Config } from "./config";

export interface MgmtTarget {
  url: string;
  token: string;
}

/**
 * 管理接口地址与凭证：只连本机回环地址，token 只从环境变量取。
 * 未启用 Web 或缺少 token 时返回 null，由调用方按「待配置」退出。
 */
export function mgmtTarget(cfg: Config): MgmtTarget | null {
  const web = cfg.web;
  if (!web?.enabled) return null;
  const token = process.env[web.tokenEnv]?.trim();
  if (!token) return null;
  return { url: `http://127.0.0.1:${web.port}`, token };
}

export interface MgmtResponse {
  status: number;
  body: Record<string, unknown>;
}

/** 调用管理接口：凭证放请求头，不进 URL 与日志 */
export async function mgmtRequest(
  target: MgmtTarget,
  method: "GET" | "POST",
  path: string,
  payload?: unknown,
): Promise<MgmtResponse> {
  const headers: Record<string, string> = { "x-pisa-token": target.token };
  if (payload !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${target.url}${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: text };
  }
  return { status: res.status, body };
}
