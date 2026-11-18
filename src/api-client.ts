import { apiInfoPath, readApiInfo, type ApiInfo, type MergeResult, type StateView, type StopResult, type TaskView, type TicketResult } from "./management";

/** CLI 退出码：脚本据此分支，不要随意改语义（见 docs/specs/015-mgmt-api） */
export type ExitCode = 0 | 1 | 2 | 3;

export class ApiError extends Error {
  constructor(
    readonly exit: ExitCode,
    message: string,
    /** 服务端 ManagementError.code；网络错误时为 null */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export interface RewindResponse {
  plan: {
    task: TaskView;
    merge: string;
    actions: Array<{ kind: string; label: string }>;
    irreversible: string[];
    notes: string[];
  };
  results: Array<{ label: string; ok: boolean; error?: string }> | null;
  rewound: boolean;
}

export interface ListQuery {
  repo?: string;
  status?: string;
  limit?: number;
  pr?: number;
  githubRepo?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** 管理接口客户端：只读 api.json 拿地址与令牌，不碰数据库 */
export class ApiClient {
  constructor(private readonly info: ApiInfo) {}

  static fromState(stateDir: string): ApiClient {
    const info = readApiInfo(stateDir);
    if (!info) {
      throw new ApiError(1, `找不到 ${apiInfoPath(stateDir)}：pisa 守护进程未运行，或版本不支持管理接口`);
    }
    return new ApiClient(info);
  }

  private async send<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "x-pisa-token": this.info.token };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.info.port}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiError(1, `无法连接 pisa 管理接口（127.0.0.1:${this.info.port}）：${(err as Error).message}`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const message =
        typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
          ? data.error
          : `HTTP ${res.status}`;
      // 401 说明守护进程刚重启、令牌已轮换：重新读取 api.json 即可，算“需重启”类
      // 服务端用 code 区分“待配置”（invalid）与普通拒绝，CLI 据此细化退出码
      const code =
        typeof data === "object" && data !== null && "code" in data && typeof data.code === "string" ? data.code : null;
      throw new ApiError(res.status === 401 ? 1 : 2, message, code);
    }
    return data as T;
  }

  state(): Promise<StateView> {
    return this.send("/state", "GET");
  }

  ticket(id: string): Promise<TaskView> {
    return this.send(`/tickets/${encodeURIComponent(id)}`, "GET");
  }

  list(query: ListQuery): Promise<TaskView[]> {
    const params = new URLSearchParams();
    if (query.repo) params.set("repo", query.repo);
    if (query.status) params.set("status", query.status);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.pr !== undefined) params.set("pr", String(query.pr));
    if (query.githubRepo) params.set("github-repo", query.githubRepo);
    const qs = params.toString();
    return this.send(`/tickets${qs ? `?${qs}` : ""}`, "GET");
  }

  logs(id: string, tail: number): Promise<string[]> {
    return this.send(`/tickets/${encodeURIComponent(id)}/logs?tail=${tail}`, "GET");
  }

  create(input: Record<string, unknown>): Promise<TicketResult> {
    return this.send("/tickets", "POST", input);
  }

  retry(id: string): Promise<TicketResult> {
    return this.send(`/tickets/${encodeURIComponent(id)}/retry`, "POST", {});
  }

  stop(id: string): Promise<StopResult> {
    return this.send(`/tickets/${encodeURIComponent(id)}/stop`, "POST", {});
  }

  merge(id: string): Promise<MergeResult> {
    return this.send(`/tickets/${encodeURIComponent(id)}/merge`, "POST", {});
  }

  rewind(id: string, execute: boolean): Promise<RewindResponse> {
    return this.send(`/tickets/${encodeURIComponent(id)}/rewind`, "POST", { execute });
  }

  pause(paused: boolean): Promise<{ paused: boolean }> {
    return this.send("/executor/pause", "POST", { paused });
  }
}
