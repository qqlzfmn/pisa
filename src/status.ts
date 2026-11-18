import type { Task, TaskStatus } from "./types";
import type { Store } from "./store";
import { STAGE_LABEL, stageText, taskStage, type TaskStage } from "./stage";
import { windowMetrics, type WindowMetrics } from "./metrics";
import { queueReason, slotText, slotUsage, type SlotLimits } from "./slots";

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

export interface StatusSnapshot {
  running: Task[];
  queued: Task[];
  finished: Task[];
  counts: Record<TaskStatus, number>;
  total: number;
}

/** 看板数据：Router 与 CLI 共用，唯一事实源 */
export function statusSnapshot(store: Store): StatusSnapshot {
  const counts = store.countByStatus();
  return {
    running: store.runningTasks(),
    queued: store.queuedTasks(),
    finished: store.recentFinished(5),
    counts,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
  };
}

/** 任务看板：槽位 / 运行中 / 排队 / 最近完成，末尾汇总 */
export function formatStatusBoard(store: Store, limits: SlotLimits, now = Date.now()): string {
  const { running, queued, finished, counts, total } = statusSnapshot(store);
  const usage = slotUsage(running.length, limits);

  const lines = [`槽位：${slotText(usage)}`, "", "运行中"];
  if (running.length === 0) lines.push("(无)");
  for (const t of running) {
    const elapsed = formatDuration(now - (t.startedAt ?? t.createdAt));
    lines.push(`${t.id} · ${stageText(t)} · ${t.repo} · 已运行 ${elapsed} · ${preview(t.prompt, 40)}`);
  }

  lines.push("", `排队（${queued.length}）`);
  if (queued.length === 0) lines.push("(无)");
  for (const t of queued.slice(0, 5)) {
    const line = `${t.id} · ${stageText(t)} · ${t.repo} · ${preview(t.prompt, 40)}`;
    // 阶段只说「等空闲槽位」，具体卡在哪一类槽位由排队原因回答
    const reason = queueReason(t.priority ?? "auto", usage);
    lines.push(reason ? `${line} · 排队原因：${reason}` : line);
  }

  lines.push("", "最近完成");
  if (finished.length === 0) lines.push("(无)");
  for (const t of finished) {
    const spent = formatDuration((t.endedAt ?? t.createdAt) - (t.startedAt ?? t.createdAt));
    const parts = [FINISHED_LABEL[t.status] ?? t.status, stageText(t), spent, t.repo, preview(t.prompt, 30)];
    if (t.prUrl) parts.push(t.prUrl);
    lines.push(parts.join(" · "));
  }

  lines.push("", `汇总：${total} 个任务 · 成功 ${counts.succeeded} · 失败 ${counts.failed} · 暂停 ${counts.paused}`);
  lines.push(formatWindowMetrics(windowMetrics(store, now)));
  return lines.join("\n");
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
