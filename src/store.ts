import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Task, TaskStatus } from "./types";
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
  resume_session_id TEXT,
  summary          TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  ended_at         INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL,
  seen_at  INTEGER NOT NULL
);
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
  resume_session_id: string | null;
  summary: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  cancel_requested: number;
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
    resumeSessionId: r.resume_session_id,
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
    if (!cols.some((c) => c.name === "resume_session_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN resume_session_id TEXT");
    }
  }

  setSessionId(id: string, sessionId: string): void {
    this.db.run("UPDATE tasks SET session_id = ? WHERE id = ?", [sessionId, id]);
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
      `INSERT INTO tasks (id, source, channel, chat_id, requester, repo, prompt, status, created_at, resume_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t.id, t.source, t.channel, t.chatId, t.requester, t.repo, t.prompt, t.status, t.createdAt, t.resumeSessionId],
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
      resumeSessionId: "resume_session_id",
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

  /** 进程重启：所有遗留 running 任务视为中断 */
  markOrphansFailed(reason: string): number {
    const rows = this.db.query("SELECT id FROM tasks WHERE status = 'running'").all() as Array<{ id: string }>;
    for (const r of rows) {
      this.transition(r.id, "failed", { error: reason, endedAt: Date.now() });
    }
    return rows.length;
  }

  recent(limit = 10): Task[] {
    const rows = this.db.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(toTask);
  }

  close(): void {
    this.db.close();
  }
}
