import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WEB, type Config } from "./config";
import type { TicketJson } from "./status";
import type { EffectKind, TaskStatus } from "./types";

/** 退出码契约：脚本按「下一步该做什么」分支 */
export const EXIT = {
  /** 正常完成 */
  ok: 0,
  /** 需要重启守护进程：连不上、心跳过期、合并后待重启 */
  restart: 1,
  /** 部件错误：4xx/5xx、任务失败、等待超时、用法错误 */
  failed: 2,
  /** 待配置：配置文件缺失、未授权、仓库/白名单未配置 */
  config: 3,
} as const;

/** 管理接口的固定错误码，客户端据此映射退出码 */
export type ApiErrorCode = "unauthorized" | "config" | "not_found" | "state";

const ERROR_CODES: Record<string, ApiErrorCode> = {
  unauthorized: "unauthorized",
  config: "config",
  not_found: "not_found",
  state: "state",
};

/** 只接受回环地址：管理面不暴露到网络，覆盖项也不能破例 */
const LOOPBACK: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
  "::1": true,
  "[::1]": true,
};

/** 管理接口根地址：`PISA_API_URL` 覆盖（仅回环），否则 127.0.0.1 + 配置端口 */
export function apiBase(cfg: Config): string {
  const override = process.env.PISA_API_URL?.trim();
  if (!override) return `http://127.0.0.1:${(cfg.web ?? DEFAULT_WEB).port}`;
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error(`PISA_API_URL 不是合法 URL：${override}`);
  }
  if (LOOPBACK[url.hostname] !== true) throw new Error(`PISA_API_URL 只接受回环地址：${override}`);
  return url.origin;
}

/**
 * 管理 token：环境变量优先，否则读写 `<stateDir>/api.token`。
 * 服务端与 CLI 共用这一份，谁先启动都能建出同一个值；文件权限 0600。
 */
export function apiToken(cfg: Config): string {
  const web = cfg.web ?? DEFAULT_WEB;
  const fromEnv = process.env[web.tokenEnv]?.trim();
  if (fromEnv) return fromEnv;
  const path = join(cfg.stateDir, "api.token");
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    // 缺失或不可读：尝试独占创建，竞争的另一个进程会写成功
  }
  mkdirSync(cfg.stateDir, { recursive: true });
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, token);
    } finally {
      closeSync(fd);
    }
    return token;
  } catch {
    return readFileSync(path, "utf8").trim();
  }
}

/** 连不上管理接口：守护进程没起，或端口/地址不对 */
export class ApiUnavailable extends Error {
  constructor(readonly base: string, cause?: unknown) {
    super(`管理接口不可达（${base}）${cause instanceof Error ? `：${cause.message}` : ""}`);
  }
}

/** 管理接口返回了错误状态 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: ApiErrorCode,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(
    readonly base: string,
    readonly token: string,
  ) {}

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          "x-pisa-token": this.token,
          "content-type": "application/json; charset=utf-8",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiUnavailable(this.base, err);
    }
    let payload: unknown = null;
    try {
      payload = JSON.parse(await res.text());
    } catch {
      payload = null;
    }
    if (!res.ok) {
      let message = `管理接口返回 ${res.status}`;
      let code: ApiErrorCode | undefined;
      if (payload && typeof payload === "object") {
        if ("error" in payload && typeof payload.error === "string") message = payload.error;
        if ("code" in payload && typeof payload.code === "string") code = ERROR_CODES[payload.code];
      }
      throw new ApiError(res.status, message, code);
    }
    if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true) {
      throw new ApiError(res.status, "管理接口返回了无法识别的响应");
    }
    return payload as T;
  }
}

/** 管理接口的响应契约：服务端构造与本客户端读取共用同一份字段 */
export interface DaemonInfo {
  alive: boolean;
  ageMs: number | null;
  lastBeat: number | null;
}

export interface ExecutorInfo {
  paused: boolean;
  concurrency: number;
  active: number;
}

export interface RepoInfo {
  alias: string;
  path: string;
  remote: string | null;
  baseBranch: string | null;
  allowed: boolean;
}

export interface StateResponse {
  ok: true;
  daemon: DaemonInfo;
  executor: ExecutorInfo;
  counts: Record<TaskStatus, number>;
  total: number;
  repos: RepoInfo[];
  repo: string | null;
  running: TicketJson[];
  queued: TicketJson[];
  finished: TicketJson[];
}

export interface TicketsResponse {
  ok: true;
  tickets: TicketJson[];
}

export interface EffectInfo {
  kind: EffectKind;
  target: string;
  detail: string | null;
  createdAt: number;
}

export interface TicketDetailResponse {
  ok: true;
  ticket: TicketJson;
  effects: EffectInfo[];
  logTail: string[];
}

export interface LogsResponse {
  ok: true;
  ticketId: string;
  path: string;
  lines: string[];
}

export interface SubmitResponse {
  ok: true;
  ticketId: string;
  ticket: TicketJson;
  message: string;
  daemon: DaemonInfo;
}

export interface ActionResponse {
  ok: boolean;
  ticket: TicketJson | null;
  message: string;
}

export interface MergeResponse extends ActionResponse {
  restartRequired: boolean;
}

export interface RewindResponse extends ActionResponse {
  applied: boolean;
}

export interface ExecutorResponse {
  ok: true;
  executor: ExecutorInfo;
}
