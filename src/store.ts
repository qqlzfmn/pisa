import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { prNumberFromIssueUrl } from "./github";
import type { Effect, EffectJob, EffectJobKind, EffectJobStatus, EffectKind, Task, TaskStatus } from "./types";
import { canTransition } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL,
  channel          TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  requester        TEXT NOT NULL,
  repo             TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  status           TEXT NOT NULL,
  branch           TEXT,
  pr_url           TEXT,
  session_id       TEXT,
  base_ref         TEXT,
  context          TEXT,
  reply_pr         INTEGER,
  reply_issue      INTEGER,
  reply_repo       TEXT,
  summary          TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  ended_at         INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);

CREATE TABLE IF NOT EXISTS task_messages (
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL,
  seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_effects (
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  target     TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind, target)
);

CREATE TABLE IF NOT EXISTS effects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  result     TEXT,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_effects_pending ON effects(status, next_at);
`;

interface Row {
  id: string;
  source: string;
  channel: string;
  chat_id: string;
  requester: string;
  repo: string;
  prompt: string;
  status: TaskStatus;
  branch: string | null;
  pr_url: string | null;
  session_id: string | null;
  base_ref: string | null;
  context: string | null;
  reply_pr: number | null;
  reply_issue: number | null;
  reply_repo: string | null;
  summary: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  cancel_requested: number;
}

interface EffectRow {
  id: number;
  kind: EffectJobKind;
  dedupe_key: string;
  payload: string;
  status: EffectJobStatus;
  attempts: number;
  next_at: number;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function toEffectJob(r: EffectRow): EffectJob {
  return {
    id: r.id,
    kind: r.kind,
    dedupeKey: r.dedupe_key,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    status: r.status,
    attempts: r.attempts,
    nextAt: r.next_at,
    result: r.result,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toTask(r: Row): Task {
  return {
    id: r.id,
    source: r.source,
    channel: r.channel,
    chatId: r.chat_id,
    requester: r.requester,
    repo: r.repo,
    prompt: r.prompt,
    status: r.status,
    branch: r.branch,
    prUrl: r.pr_url,
    sessionId: r.session_id,
    baseRef: r.base_ref,
    context: r.context,
    replyPr: r.reply_pr,
    replyIssue: r.reply_issue,
    replyRepo: r.reply_repo,
    summary: r.summary,
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    cancelRequested: r.cancel_requested === 1,
  };
}

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // 轻量迁移：给已有库补列
    const cols = this.db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "session_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT");
    }
    if (!cols.some((c) => c.name === "base_ref")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN base_ref TEXT");
    }
    if (!cols.some((c) => c.name === "context")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN context TEXT");
    }
    if (!cols.some((c) => c.name === "reply_pr")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN reply_pr INTEGER");
    }
    if (!cols.some((c) => c.name === "reply_issue")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN reply_issue INTEGER");
    }
    if (!cols.some((c) => c.name === "reply_repo")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN reply_repo TEXT");
    }
  }

  /** 记录「哪条发出的消息属于哪个任务」，用于回复接续 */
  linkMessage(chatId: string, messageId: string, taskId: string): void {
    this.db.run("INSERT OR REPLACE INTO task_messages(chat_id, message_id, task_id, created_at) VALUES (?, ?, ?, ?)", [
      chatId,
      messageId,
      taskId,
      Date.now(),
    ]);
  }

  taskByMessage(chatId: string, messageId: string): string | null {
    const row = this.db.query("SELECT task_id FROM task_messages WHERE chat_id = ? AND message_id = ?").get(chatId, messageId) as
      | { task_id: string }
      | null;
    return row?.task_id ?? null;
  }

  setSessionId(id: string, sessionId: string): void {
    this.db.run("UPDATE tasks SET session_id = ? WHERE id = ?", [sessionId, id]);
  }

  /** 记一条副作用；同一任务同类同对象的重复记录合并为最新一条 */
  effect(taskId: string, kind: EffectKind, target: string, detail: string | null = null): void {
    this.db.run(
      "INSERT OR REPLACE INTO task_effects(task_id, kind, target, detail, created_at) VALUES (?, ?, ?, ?, ?)",
      [taskId, kind, target, detail, Date.now()],
    );
  }

  /** 撤销或自然回收后删掉记录，账本只留仍然存在的副作用 */
  removeEffect(taskId: string, kind: EffectKind, target: string): void {
    this.db.run("DELETE FROM task_effects WHERE task_id = ? AND kind = ? AND target = ?", [taskId, kind, target]);
  }

  effectsOf(taskId: string): Effect[] {
    const rows = this.db
      .query("SELECT task_id, kind, target, detail, created_at FROM task_effects WHERE task_id = ? ORDER BY created_at, kind, target")
      .all(taskId) as Array<{ task_id: string; kind: EffectKind; target: string; detail: string | null; created_at: number }>;
    return rows.map((r) => ({ taskId: r.task_id, kind: r.kind, target: r.target, detail: r.detail, createdAt: r.created_at }));
  }

  /**
   * 入队：同 (kind, dedupeKey) 只保留一行。已完成的直接复用结果；
   * 上次耗尽的失败行重置为待执行，新的调用方代表新的意图。
   */
  enqueueEffect(kind: EffectJobKind, dedupeKey: string, payload: Record<string, unknown>, now: number): EffectJob {
    this.db.run(
      `INSERT OR IGNORE INTO effects(kind, dedupe_key, payload, status, attempts, next_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
      [kind, dedupeKey, JSON.stringify(payload), now, now, now],
    );
    this.db.run(
      "UPDATE effects SET status = 'pending', attempts = 0, next_at = ?, error = NULL, updated_at = ? WHERE kind = ? AND dedupe_key = ? AND status = 'failed'",
      [now, now, kind, dedupeKey],
    );
    return this.effectJob(kind, dedupeKey)!;
  }

  effectJob(kind: EffectJobKind, dedupeKey: string): EffectJob | null {
    const row = this.db
      .query("SELECT * FROM effects WHERE kind = ? AND dedupe_key = ?")
      .get(kind, dedupeKey) as EffectRow | null;
    return row ? toEffectJob(row) : null;
  }

  /** 所有未完成的 effect，按可执行时间排序；重启后重放用 */
  pendingEffects(): EffectJob[] {
    const rows = this.db
      .query("SELECT * FROM effects WHERE status = 'pending' ORDER BY next_at, id")
      .all() as EffectRow[];
    return rows.map(toEffectJob);
  }

  /** 一次失败：记次数、错误与下次可执行时间 */
  deferEffect(id: number, attempts: number, nextAt: number, error: string, now: number): void {
    this.db.run("UPDATE effects SET attempts = ?, next_at = ?, error = ?, updated_at = ? WHERE id = ?", [
      attempts,
      nextAt,
      error,
      now,
      id,
    ]);
  }

  settleEffect(id: number, status: "done" | "failed", result: string | null, error: string | null, now: number): void {
    this.db.run("UPDATE effects SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?", [
      status,
      result,
      error,
      now,
      id,
    ]);
  }

  /** 幂等：同一事件只能登记一次 */
  claimEvent(eventId: string, taskId: string): boolean {
    const res = this.db.run("INSERT OR IGNORE INTO events(event_id, task_id, seen_at) VALUES (?, ?, ?)", [
      eventId,
      taskId,
      Date.now(),
    ]);
    return res.changes > 0;
  }

  insertTask(t: Task): void {
    this.db.run(
      `INSERT INTO tasks (id, source, channel, chat_id, requester, repo, prompt, status, branch, pr_url, created_at, base_ref, context, reply_pr, reply_issue, reply_repo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id,
        t.source,
        t.channel,
        t.chatId,
        t.requester,
        t.repo,
        t.prompt,
        t.status,
        t.branch,
        t.prUrl,
        t.createdAt,
        t.baseRef,
        t.context,
        t.replyPr,
        t.replyIssue,
        t.replyRepo,
      ],
    );
  }

  get(id: string): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row | null;
    return row ? toTask(row) : null;
  }

  /** 原子占位：queued → running，失败说明已被别的槽位取走 */
  claimQueued(id: string, startedAt: number, branch: string): boolean {
    const res = this.db.run(
      "UPDATE tasks SET status = 'running', started_at = ?, branch = ? WHERE id = ? AND status = 'queued'",
      [startedAt, branch, id],
    );
    return res.changes > 0;
  }

  /**
   * 该 PR 下最近一次成功的任务；pr_url 形如 .../pull/<n>。
   * 带 repo 时只认 github.com/<repo>/pull/<n>，避免不同仓库的同号 PR 串任务。
   */
  taskByPr(pr: number, repo?: string): Task | null {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE status = 'succeeded' AND pr_url LIKE ? ORDER BY created_at DESC")
      .all(`%/pull/${pr}%`) as Row[];
    return (
      rows
        .map(toTask)
        .find(
          (t) =>
            t.prUrl &&
            prNumberFromIssueUrl(t.prUrl) === pr &&
            (!repo || t.prUrl.includes(`github.com/${repo}/pull/${pr}`)),
        ) ?? null
    );
  }

  nextQueued(): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as Row | null;
    return row ? toTask(row) : null;
  }

  /** 唯一的状态写入入口；非法跃迁返回 false */
  transition(id: string, to: TaskStatus, patch: Partial<Omit<Task, "id" | "status">> = {}): boolean {
    const cur = this.get(id);
    if (!cur) return false;
    if (!canTransition(cur.status, to)) return false;

    const sets: string[] = ["status = ?"];
    const vals: Array<string | number | null> = [to];
    const map: Record<string, string> = {
      branch: "branch",
      prUrl: "pr_url",
      sessionId: "session_id",
      baseRef: "base_ref",
      context: "context",
      replyPr: "reply_pr",
      replyIssue: "reply_issue",
      replyRepo: "reply_repo",
      summary: "summary",
      error: "error",
      startedAt: "started_at",
      endedAt: "ended_at",
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col} = ?`);
        vals.push((patch as Record<string, string | number | null>)[k] ?? null);
      }
    }
    vals.push(id, cur.status);
    const res = this.db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND status = ?`, vals);
    return res.changes > 0;
  }

  requestCancel(id: string): boolean {
    const res = this.db.run("UPDATE tasks SET cancel_requested = 1 WHERE id = ? AND status IN ('queued','running')", [id]);
    return res.changes > 0;
  }

  isCancelRequested(id: string): boolean {
    const row = this.db.query("SELECT cancel_requested FROM tasks WHERE id = ?").get(id) as { cancel_requested: number } | null;
    return row?.cancel_requested === 1;
  }

  /** 执行中任务；启动恢复（分流为 paused / failed）与看板共用 */
  runningTasks(): Task[] {
    const rows = this.db.query("SELECT * FROM tasks WHERE status = 'running' ORDER BY created_at").all() as Row[];
    return rows.map(toTask);
  }

  /** 排队任务，先来先跑 */
  queuedTasks(): Task[] {
    const rows = this.db.query("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at").all() as Row[];
    return rows.map(toTask);
  }

  /** 按创建时间倒序取任务，不筛状态 */
  recentTasks(limit = 10): Task[] {
    const rows = this.db.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(toTask);
  }

  /** 终态任务，按创建时间倒序；看板「最近完成」用，先筛后限避免被未完成任务挤掉 */
  recentFinished(limit = 5): Task[] {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE status IN ('succeeded','failed','cancelled','rewound') ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(toTask);
  }

  /** 各状态任务数；看板汇总行用 */
  countByStatus(): Record<TaskStatus, number> {
    const rows = this.db.query("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all() as Array<{
      status: TaskStatus;
      n: number;
    }>;
    const counts: Record<TaskStatus, number> = {
      queued: 0,
      running: 0,
      paused: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      rewound: 0,
    };
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }

  close(): void {
    this.db.close();
  }
}
