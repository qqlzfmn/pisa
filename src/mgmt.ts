import { DEFAULT_WEB, type Config, type WebConfig } from "./config";
import type { Health } from "./health";
import type { ActionOutcome } from "./router";
import type { DaemonState } from "./status";

/** 管理接口不可达：守护进程没起，或没开 web */
export class MgmtUnreachable extends Error {}

/** 凭证缺失或不匹配：先设置 token 环境变量，并让守护进程用同一个值启动 */
export class MgmtUnauthorized extends Error {}

/** `/api/state` 的投影；任务列表保持接口原样，CLI 只透传 */
export interface MgmtState {
  daemon: DaemonState;
  executor: { paused: boolean; active: number; concurrency: number } | null;
  health: Health;
  counts: Record<string, number>;
  total: number;
  repos: string[];
  running: unknown[];
  queued: unknown[];
  finished: unknown[];
}

function webOf(cfg: Config): WebConfig {
  return cfg.web ?? DEFAULT_WEB;
}

export function mgmtBase(cfg: Config): string {
  return `http://127.0.0.1:${webOf(cfg).port}`;
}

/** 管理接口要的请求头；token 与守护进程同源（web.tokenEnv） */
export function mgmtToken(cfg: Config): string | null {
  const env = webOf(cfg).tokenEnv;
  return process.env[env]?.trim() || null;
}

export const MGMT_TIMEOUT_MS = 5_000;
/** 合并要跑测试再快进，不能按普通请求超时 */
export const MGMT_ACTION_TIMEOUT_MS = 10 * 60 * 1000;

async function request(
  cfg: Config,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (!webOf(cfg).enabled) {
    throw new MgmtUnreachable("管理接口未启用：配置 web.enabled 或用 pisa --web 启动守护进程");
  }
  const token = mgmtToken(cfg);
  if (!token) {
    const env = webOf(cfg).tokenEnv;
    throw new MgmtUnauthorized(`未设置 ${env}，管理接口需要请求头鉴权`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? MGMT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(`${mgmtBase(cfg)}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
  } catch {
    throw new MgmtUnreachable(`管理接口不可达：${mgmtBase(cfg)}（用 --web 或 web.enabled 启动守护进程）`);
  } finally {
    clearTimeout(timer);
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) throw new MgmtUnauthorized(`管理接口拒绝凭证，检查 ${webOf(cfg).tokenEnv} 是否与守护进程一致`);
  if (!res.ok && data.ok !== false) throw new Error(`管理接口返回 HTTP ${res.status}`);
  return data;
}

/** 读取守护进程状态；守护进程不在时抛 MgmtUnreachable，调用方决定是否回落本地库 */
export async function mgmtState(cfg: Config, fetchImpl: typeof fetch = fetch): Promise<MgmtState> {
  const data = await request(cfg, "/api/state", {}, fetchImpl);
  if (data.ok !== true) throw new Error(typeof data.error === "string" ? data.error : "管理接口响应异常");
  return data as unknown as MgmtState;
}

/** 执行一个管理动作，返回与 Router 同语义的结论 */
export async function mgmtAction(
  cfg: Config,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<ActionOutcome> {
  const data = await request(cfg, path, { method: "POST", body: body ?? {}, timeoutMs: MGMT_ACTION_TIMEOUT_MS }, fetchImpl);
  const raw = data.code;
  const failure = raw === 3 || raw === 4 ? raw : raw === 2 ? 2 : null;
  if (data.ok === true && failure === null) {
    return { ok: true, code: 0, message: text(data.message) || text(data.error), ...taskIdOf(data) };
  }
  return { ok: false, code: failure ?? 2, message: text(data.message) || text(data.error), ...taskIdOf(data) };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function taskIdOf(data: Record<string, unknown>): { taskId?: string } {
  return typeof data.taskId === "string" && data.taskId ? { taskId: data.taskId } : {};
}
