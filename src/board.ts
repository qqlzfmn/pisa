import type { Store } from "./store";
import type { Task, TaskStatus } from "./types";

/** 状态快照：IM 看板、管理接口与 CLI 共用同一份数据 */
export interface StateSnapshot {
  paused: boolean;
  counts: Record<TaskStatus, number>;
  running: Task[];
  queued: Task[];
  /** 最近 5 条终态任务 */
  finished: Task[];
}

export function snapshot(store: Store, paused: boolean): StateSnapshot {
  return {
    paused,
    counts: store.countByStatus(),
    running: store.runningTasks(),
    queued: store.queuedTasks(),
    finished: store.recentFinished(5),
  };
}

/** 毫秒 → 人类可读时长：不足 1 分钟给秒，不足 1 小时给 XmYs，其余 XhYm */
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

/** 需求单行预览：折叠换行与连续空白，超长截断并补省略号 */
function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const FINISHED_LABEL: Record<string, string> = { succeeded: "成功", failed: "失败", cancelled: "取消", rewound: "已撤销" };

/** 任务看板：运行中 / 排队 / 最近完成，末尾汇总 */
export function formatBoard(state: StateSnapshot, now: number): string {
  const { running, queued, finished, counts } = state;
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const lines = [state.paused ? "执行器：已暂停（不再接新任务）" : "执行器：运行中", ""];
  lines.push("运行中");
  if (running.length === 0) lines.push("(无)");
  for (const t of running) {
    const elapsed = formatDuration(now - (t.startedAt ?? t.createdAt));
    lines.push(`${t.id} · ${t.repo} · 已运行 ${elapsed} · ${preview(t.prompt, 40)}`);
  }

  lines.push("", `排队（${queued.length}）`);
  if (queued.length === 0) lines.push("(无)");
  for (const t of queued.slice(0, 5)) lines.push(`${t.id} · ${t.repo} · ${preview(t.prompt, 40)}`);

  lines.push("", "最近完成");
  if (finished.length === 0) lines.push("(无)");
  for (const t of finished) {
    const spent = formatDuration((t.endedAt ?? t.createdAt) - (t.startedAt ?? t.createdAt));
    const parts = [FINISHED_LABEL[t.status] ?? t.status, spent, t.repo, preview(t.prompt, 30)];
    if (t.prUrl) parts.push(t.prUrl);
    lines.push(parts.join(" · "));
  }

  lines.push("", `汇总：${total} 个任务 · 成功 ${counts.succeeded} · 失败 ${counts.failed} · 暂停 ${counts.paused}`);
  return lines.join("\n");
}
