import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 控制面地址与 token：默认读 stateDir/api.json，环境变量可覆盖（测试与临时实例用） */
export interface ApiTarget {
  url: string;
  token: string;
}

export interface ApiReply<T = unknown> {
  status: number;
  body: T;
}

/** 接口不可达：守护进程没起来或端口不对，调用方据此给「需重启」 */
export class ApiUnreachable extends Error {}

export function apiTarget(stateDir: string): ApiTarget | null {
  const url = process.env.PISA_API_URL?.trim();
  const token = process.env.PISA_API_TOKEN?.trim();
  if (url && token) return { url: url.replace(/\/+$/, ""), token };
  const file = join(stateDir, "api.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { url?: unknown; token?: unknown };
    if (typeof raw.url !== "string" || typeof raw.token !== "string" || !raw.url || !raw.token) return null;
    return { url: raw.url.replace(/\/+$/, ""), token: raw.token };
  } catch {
    return null;
  }
}

/** 管理接口的最小客户端：只用请求头带 token，与 CLI 的脚本化路径一致 */
export class ApiClient {
  constructor(private readonly target: ApiTarget) {}

  get<T = unknown>(path: string): Promise<ApiReply<T>> {
    return this.request<T>("GET", path);
  }

  post<T = unknown>(path: string, body?: unknown): Promise<ApiReply<T>> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<ApiReply<T>> {
    const headers: Record<string, string> = { "x-pisa-token": this.target.token };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`${this.target.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiUnreachable(`管理接口不可达（${this.target.url}）：${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { ok: false, error: text };
    }
    return { status: res.status, body: parsed as T };
  }
}
