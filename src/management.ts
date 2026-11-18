import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daemonState, statusSnapshot, type DaemonState } from "./status";
import type { Store } from "./store";
import type { Task, TaskStatus } from "./types";

/**
 * 管理操作的业务失败：HTTP 层映射状态码，IM 层取 message 直接回复。
 * forbidden 只在 IM 命令带请求者校验时出现；API 的权限由令牌承担。
 */
export type ManagementErrorCode = "invalid" | "forbidden" | "not_found" | "conflict";

export class ManagementError extends Error {
  constructor(
    readonly code: ManagementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagementError";
  }
}

/** 任务对外视图：API 与 CLI 共用，只暴露调用方需要且无敏感信息的字段 */
export interface TaskView {
  id: string;
  status: TaskStatus;
  repo: string;
  branch: string | null;
  prUrl: string | null;
  baseRef: string | null;
  prompt: string;
  summary: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export function taskView(t: Task): TaskView {
  return {
    id: t.id,
    status: t.status,
    repo: t.repo,
    branch: t.branch,
    prUrl: t.prUrl,
    baseRef: t.baseRef,
    prompt: t.prompt,
    summary: t.summary,
    error: t.error,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
  };
}

export interface StateView {
  daemon: DaemonState;
  executor: { paused: boolean };
  counts: Record<TaskStatus, number>;
  total: number;
  running: TaskView[];
  queued: TaskView[];
  finished: TaskView[];
}

/** GET /state 的数据源；CLI status 与 API 共用 */
export function stateView(store: Store, now = Date.now()): StateView {
  const snapshot = statusSnapshot(store);
  return {
    daemon: daemonState(store, now),
    executor: { paused: store.executorPaused() },
    counts: snapshot.counts,
    total: snapshot.total,
    running: snapshot.running.map(taskView),
    queued: snapshot.queued.map(taskView),
    finished: snapshot.finished.map(taskView),
  };
}

export interface CreateTicketInput {
  prompt: string;
  repo?: string;
  requester?: string;
  eventId?: string;
  /** 续跑：从该分支起步，并把上一轮上下文注入 Worker */
  baseRef?: string;
  context?: string;
  prUrl?: string;
}

export interface TicketResult {
  ticket: TaskView;
  created: boolean;
}

export interface StopResult {
  ticket: TaskView;
  state: "cancelled" | "cancelling";
  message: string;
}

export interface MergeResult {
  ok: boolean;
  detail: string;
  base: string | null;
}

export interface ApiInfo {
  port: number;
  token: string;
}

export function apiInfoPath(stateDir: string): string {
  return join(stateDir, "api.json");
}

/** 端口与令牌只落本机状态目录；0600 防止同机其它用户读取 */
export function writeApiInfo(stateDir: string, info: ApiInfo): void {
  writeFileSync(apiInfoPath(stateDir), JSON.stringify(info), { mode: 0o600 });
}

export function readApiInfo(stateDir: string): ApiInfo | null {
  const path = apiInfoPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ApiInfo>;
    if (!Number.isInteger(raw.port) || raw.port! < 1 || raw.port! > 65535) return null;
    if (typeof raw.token !== "string" || raw.token.length === 0) return null;
    return { port: raw.port!, token: raw.token };
  } catch {
    return null;
  }
}

export function removeApiInfo(stateDir: string): void {
  rmSync(apiInfoPath(stateDir), { force: true });
}
