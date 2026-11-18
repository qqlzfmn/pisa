import type { Config } from "./config";

/** 请求超时：所有管理接口都是本机调用，超过这个时间按部件故障处理 */
const REQUEST_TIMEOUT_MS = 10_000;

/** 需要先配置才能继续（未开启管理 API、缺 token） */
export class UnconfiguredError extends Error {}

/** 守护进程没跑或端口不通 */
export class UnreachableError extends Error {}

/** token 不匹配：配置与进程用的不是同一个 */
export class UnauthorizedError extends Error {}

/** 服务端拒绝或业务失败，带 HTTP 状态码 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 管理 API 客户端：只连 127.0.0.1，token 走请求头 */
export class Mgmt {
  private readonly base: string;
  private readonly token: string;

  constructor(port: number, token: string) {
    this.base = `http://127.0.0.1:${port}`;
    this.token = token;
  }

  get<T>(path: string): Promise<T> {
    return this.call<T>("GET", path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>("POST", path, body);
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { "x-pisa-token": this.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new UnreachableError(`管理 API 不可达（${this.base}）：守护进程没在运行？${err instanceof Error ? `（${err.message}）` : ""}`);
    }
    const payload = await res.json().catch(() => null) as { error?: string; message?: string } | null;
    if (res.status === 401 || res.status === 403) {
      throw new UnauthorizedError(`token 被拒绝：检查守护进程的 web.tokenEnv 与当前环境变量是否一致（${payload?.error ?? res.statusText}）`);
    }
    if (!res.ok) throw new ApiError(res.status, payload?.error ?? payload?.message ?? `${res.status} ${res.statusText}`);
    return payload as T;
  }
}

/** 按配置构造客户端；未启用或没配 token 时抛出 UnconfiguredError */
export function mgmtFor(cfg: Config, env: NodeJS.ProcessEnv = process.env): Mgmt {
  const web = cfg.web;
  if (!web?.enabled) {
    throw new UnconfiguredError("管理 API 未启用：在 pisa.json 的 web.enabled 打开，或用 pisa --web 启动守护进程");
  }
  const token = env[web.tokenEnv]?.trim();
  if (!token) {
    throw new UnconfiguredError(`管理 API 需要 token：设置环境变量 ${web.tokenEnv}（值需与守护进程一致）`);
  }
  return new Mgmt(web.port, token);
}
