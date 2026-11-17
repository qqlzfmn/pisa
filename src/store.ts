import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { prNumberFromIssueUrl } from "./github";
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
  base_ref         TEXT,
  context          TEXT,
  reply_pr         INTEGER,
  reply_issue      INTEGER,
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
    baseRef: r.base_ref,
    context: r.context,
    replyPr: r.reply_pr,
    replyIssue: r.reply_issue,
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
      `INSERT INTO tasks (id, source, channel, chat_id, requester, repo, prompt, status, branch, pr_url, created_at, base_ref, context, reply_pr, reply_issue)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  /** 该 PR 下最近一次成功的任务；pr_url 形如 .../pull/<n> */
  taskByPr(pr: number): Task | null {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE status = 'succeeded' AND pr_url LIKE ? ORDER BY created_at DESC")
      .all(`%/pull/${pr}%`) as Row[];
    return rows.map(toTask).find((t) => t.prUrl && prNumberFromIssueUrl(t.prUrl) === pr) ?? null;
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

  /** 遗留的执行中任务；启动时由 Router 分流为 paused 或 failed */
  listRunning(): Task[] {
    const rows = this.db.query("SELECT * FROM tasks WHERE status = 'running' ORDER BY created_at").all() as Row[];
    return rows.map(toTask);
  }

  recent(limit = 10): Task[] {
    const rows = this.db.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(toTask);
  }

  close(): void {
    this.db.close();
  }
}
