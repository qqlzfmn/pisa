import type { Task, TaskStatus } from "./types";
import type { Store } from "./store";
import { STAGE_LABEL, taskStage, type TaskStage } from "./stage";
import { windowMetrics, type WindowMetrics } from "./metrics";

/** 毫秒 → 人类可读时长：不足 1 分钟给秒，不足 1 小时给 XmYs，其余 XhYm */
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

/** 需求单行预览：折叠换行与连续空白，超长截断并补省略号 */
export function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const FINISHED_LABEL: Record<string, string> = { succeeded: "成功", failed: "失败", cancelled: "取消", rewound: "已撤销" };

/** 任务 JSON 投影的字段契约：CLI 输出与 Web 看板共用 */
export interface TaskJson {
  id: string;
  status: TaskStatus;
  /** 派生阶段：在等谁、需要什么；不写库 */
  stage: TaskStage;
  stageLabel: string;
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
  duration: string;
}

/**
 * 任务 JSON 投影：CLI 与 Web 控制台共用，避免两处字段集合漂移。
 * 只含对外需要且无敏感信息的字段；duration 按结束时间（运行中按当前时间）计算。
 */
export function taskJson(t: Task, now = Date.now()): TaskJson {
  const from = t.startedAt ?? t.createdAt;
  const stage = taskStage(t);
  return {
    id: t.id,
    status: t.status,
    stage,
    stageLabel: STAGE_LABEL[stage],
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
    duration: formatDuration((t.endedAt ?? now) - from),
  };
}

/** 看板的 JSON 形态：管理接口、CLI 与文本看板共用，字段来自 TaskJson */
export interface BoardView {
  running: TaskJson[];
  queued: TaskJson[];
  finished: TaskJson[];
  counts: Record<TaskStatus, number>;
  total: number;
}

/**
 * 看板快照：running 全量返回，queued/finished 由入口给上限；
 * total 与 counts 始终是全库口径，截断只影响列表长度。
 */
export function boardView(
  store: Store,
  now = Date.now(),
  limits: { queued?: number; finished?: number } = {},
): BoardView {
  const counts = store.countByStatus();
  const queued = store.queuedTasks();
  return {
    running: store.runningTasks().map((t) => taskJson(t, now)),
    queued: (limits.queued === undefined ? queued : queued.slice(0, limits.queued)).map((t) => taskJson(t, now)),
    finished: store.recentFinished(limits.finished ?? 5).map((t) => taskJson(t, now)),
    counts,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
  };
}

/** 文本看板：只依赖 JSON 投影，守护进程与 CLI 输出同一份 */
export function formatBoard(view: BoardView): string {
  const lines = ["运行中"];
  if (view.running.length === 0) lines.push("(无)");
  for (const t of view.running) {
    lines.push(`${t.id} · ${t.stage}（${t.stageLabel}） · ${t.repo} · 已运行 ${t.duration} · ${preview(t.prompt, 40)}`);
  }

  lines.push("", `排队（${view.counts.queued}）`);
  if (view.queued.length === 0) lines.push("(无)");
  for (const t of view.queued.slice(0, 5)) {
    lines.push(`${t.id} · ${t.stage}（${t.stageLabel}） · ${t.repo} · ${preview(t.prompt, 40)}`);
  }

  lines.push("", "最近完成");
  if (view.finished.length === 0) lines.push("(无)");
  for (const t of view.finished) {
    const parts = [FINISHED_LABEL[t.status] ?? t.status, `${t.stage}（${t.stageLabel}）`, t.duration, t.repo, preview(t.prompt, 30)];
    if (t.prUrl) parts.push(t.prUrl);
    lines.push(parts.join(" · "));
  }

  lines.push("", `汇总：${view.total} 个任务 · 成功 ${view.counts.succeeded} · 失败 ${view.counts.failed} · 暂停 ${view.counts.paused}`);
  return lines.join("\n");
}

/** 任务看板：运行中 / 排队 / 最近完成，末尾汇总 */
export function formatStatusBoard(store: Store, now = Date.now()): string {
  return `${formatBoard(boardView(store, now))}\n${formatWindowMetrics(windowMetrics(store, now))}`;
}

/** 24h 指标单行：看板与 CLI 文本输出共用 */
export function formatWindowMetrics(m: WindowMetrics): string {
  if (m.finished === 0) return "最近 24h：无完成";
  const rate = m.successRate === null ? "-" : `${Math.round(m.successRate * 100)}%`;
  const p50 = m.p50Ms === null ? "-" : formatDuration(m.p50Ms);
  const p95 = m.p95Ms === null ? "-" : formatDuration(m.p95Ms);
  return `最近 24h：完成 ${m.finished} · 成功 ${m.succeeded} · 失败 ${m.failed} · 成功率 ${rate} · P50 ${p50} · P95 ${p95}`;
}

/** 守护进程心跳超过该时长视为未运行 */
export const HEARTBEAT_STALE_MS = 10_000;

export interface DaemonState {
  alive: boolean;
  /** 距最后一次心跳的毫秒数；从未心跳时为 null */
  ageMs: number | null;
  lastBeat: number | null;
}

export function daemonState(store: Store, now = Date.now()): DaemonState {
  const lastBeat = store.lastBeat();
  const ageMs = lastBeat === null ? null : Math.max(0, now - lastBeat);
  return { alive: ageMs !== null && ageMs <= HEARTBEAT_STALE_MS, ageMs, lastBeat };
}
