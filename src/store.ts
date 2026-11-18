import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { prNumberFromIssueUrl } from "./github";
import { makeTrigger, type Trigger, type TriggerRecord } from "./trigger";
import type { Effect, EffectKind, Task, TaskStatus } from "./types";
import { canTransition } from "./types";

/** 终态状态集合：看板「最近完成」与保留策略共用 */
const FINISHED_IN = "('succeeded','failed','cancelled','rewound')";

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

-- 触发记录：任务之间的去重与线程归属都在这里，是任务创建的唯一入口依据
CREATE TABLE IF NOT EXISTS triggers (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  thread_key   TEXT NOT NULL,
  message_key  TEXT NOT NULL,
  actor        TEXT NOT NULL,
  at           INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  version      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  task_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_triggers_message ON triggers(thread_key, message_key);

CREATE TABLE IF NOT EXISTS task_effects (
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  target     TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind, target)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS effects (
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  task_id    TEXT,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL,
  result     TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_effects_due ON effects(status, next_at);
`;

/** 外部动作的执行状态：pending 待执行/重试，done 已完成，failed 超过重试上限后终止 */
export type EffectStatus = "pending" | "done" | "failed";

/** outbox 行：与 task_effects 账本不同，这里记录「动作做过没有、要不要重试」 */
export interface EffectRow {
  kind: string;
  key: string;
  taskId: string | null;
  payload: string;
  status: EffectStatus;
  result: string | null;
  attempts: number;
  nextAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface EffectDbRow {
  kind: string;
  key: string;
  task_id: string | null;
  payload: string;
  status: EffectStatus;
  result: string | null;
  attempts: number;
  next_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function toEffect(r: EffectDbRow): EffectRow {
  return {
    kind: r.kind,
    key: r.key,
    taskId: r.task_id,
    payload: r.payload,
    status: r.status,
    result: r.result,
    attempts: r.attempts,
    nextAt: r.next_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

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

/** 一次触发落库的结果 */
interface TriggerClaim {
  taskId: string;
  created: boolean;
  /** 同一消息的新版本：已挂到原任务上留痕 */
  edited: boolean;
  /** 原任务仍在排队，需求正文已换成最新版本 */
  promptUpdated: boolean;
}

interface TriggerRow {
  id: string;
  source: string;
  thread_key: string;
  message_key: string;
  actor: string;
  at: number;
  payload_hash: string;
  version: string;
  kind: string;
  task_id: string | null;
}

function toTrigger(r: TriggerRow): TriggerRecord {
  return {
    id: r.id,
    source: r.source,
    threadKey: r.thread_key,
    messageKey: r.message_key,
    actor: r.actor,
    at: r.at,
    payloadHash: r.payload_hash,
    version: r.version,
    kind: r.kind === "context" ? "context" : "task",
    taskId: r.task_id,
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

/** 状态计数的零值：所有计数查询都从同一份状态全集起算 */
function zeroCounts(): Record<TaskStatus, number> {
  return { queued: 0, running: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0, rewound: 0 };
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
    this.backfillTriggers();
  }

  /**
   * 旧库的任务没有触发器记录：按任务自身的入口信息补一条，重放旧事件才不会新建任务。
   * 只写 triggers，不动 tasks；线程键与 core 的缺省成线程规则一致。
   */
  private backfillTriggers(): void {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE id NOT IN (SELECT task_id FROM triggers WHERE task_id IS NOT NULL)")
      .all() as Row[];
    if (rows.length === 0) return;
    this.db.transaction(() => {
      for (const row of rows) {
        const task = toTask(row);
        this.insertTrigger(
          makeTrigger({
            source: task.channel,
            threadKey: `${task.channel}:${task.chatId}:${task.source}`,
            messageKey: task.source,
            actor: task.requester,
            at: task.createdAt,
            text: task.prompt,
          }),
          "task",
          task.id,
        );
      }
    })();
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

  /** 后台重试的 PR effect 完成后回填链接 */
  setPrUrl(id: string, prUrl: string): void {
    this.db.run("UPDATE tasks SET pr_url = ? WHERE id = ?", [prUrl, id]);
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

  /** 入队一条外部动作；键已存在时原样返回已有行，由调用方决定是否执行 */
  enqueueEffect(input: { kind: string; key: string; taskId: string | null; payload: string; at: number }): EffectRow {
    this.db.run(
      "INSERT OR IGNORE INTO effects(kind, key, task_id, payload, status, next_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
      [input.kind, input.key, input.taskId, input.payload, input.at, input.at, input.at],
    );
    const row = this.effectRow(input.kind, input.key);
    if (!row) throw new Error(`effect 入队失败：${input.kind}:${input.key}`);
    return row;
  }

  effectRow(kind: string, key: string): EffectRow | null {
    const row = this.db.query("SELECT * FROM effects WHERE kind = ? AND key = ?").get(kind, key) as EffectDbRow | null;
    return row ? toEffect(row) : null;
  }

  /** 到期且未完成的 outbox 行，按到期时间排序 */
  dueEffects(at: number, kinds: string[], limit = 20): EffectRow[] {
    if (kinds.length === 0) return [];
    const marks = kinds.map(() => "?").join(", ");
    const rows = this.db
      .query(
        `SELECT * FROM effects WHERE status = 'pending' AND next_at <= ? AND kind IN (${marks}) ORDER BY next_at, created_at LIMIT ?`,
      )
      .all(at, ...kinds, limit) as EffectDbRow[];
    return rows.map(toEffect);
  }

  completeEffect(kind: string, key: string, result: string | null, at: number): EffectRow | null {
    this.db.run(
      "UPDATE effects SET status = 'done', result = ?, last_error = NULL, updated_at = ? WHERE kind = ? AND key = ?",
      [result, at, kind, key],
    );
    return this.effectRow(kind, key);
  }

  /** 记一次失败：attempts 自增，next_at 由调用方按退避算好；terminal 时不再重试 */
  failEffect(
    kind: string,
    key: string,
    error: string,
    opts: { nextAt: number; terminal: boolean },
    at: number,
  ): EffectRow | null {
    this.db.run(
      "UPDATE effects SET attempts = attempts + 1, last_error = ?, next_at = ?, status = ?, updated_at = ? WHERE kind = ? AND key = ?",
      [error, opts.nextAt, opts.terminal ? "failed" : "pending", at, kind, key],
    );
    return this.effectRow(kind, key);
  }

  /** 任务终止：它未完成的外部动作不再重试 */
  dropPendingEffects(taskId: string): number {
    return this.db.run("DELETE FROM effects WHERE task_id = ? AND status = 'pending'", [taskId]).changes;
  }

  /** 跨重启的单值状态（心跳、轮询游标）；调用方自己约定 key */
  setMeta(key: string, value: string): void {
    this.db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  /** 守护进程心跳：CLI 用它判断任务是否真的会被执行 */
  beat(at = Date.now()): void {
    this.setMeta("heartbeat", String(at));
  }

  lastBeat(): number | null {
    const value = this.getMeta("heartbeat");
    if (value === null) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }

  /** 线程里某条消息最新的触发记录：重复投递与编辑都靠它认出原任务 */
  triggerByMessage(threadKey: string, messageKey: string): TriggerRecord | null {
    const row = this.db
      .query("SELECT * FROM triggers WHERE thread_key = ? AND message_key = ? ORDER BY rowid DESC LIMIT 1")
      .get(threadKey, messageKey) as TriggerRow | null;
    return row ? toTrigger(row) : null;
  }

  /**
   * 触发器的唯一落库口：新触发建任务；同一条消息的新版本挂到原任务上。
   *
   * 整个判断在一个事务里，所以重复投递和并发投递都只会有一个任务。
   */
  createTaskFromTrigger(trigger: Trigger, task: Task): TriggerClaim {
    const claim: TriggerClaim = { taskId: task.id, created: false, edited: false, promptUpdated: false };
    this.db.transaction(() => {
      const prior = this.triggerByMessage(trigger.threadKey, trigger.messageKey);
      if (prior) {
        claim.taskId = prior.taskId ?? task.id;
        if (prior.id === trigger.id) return; // 重复投递：原样返回已有任务
        claim.edited = true;
        this.insertTrigger(trigger, "context", claim.taskId);
        claim.promptUpdated = this.updatePrompt(claim.taskId, task.prompt);
        return;
      }
      this.insertTrigger(trigger, "task", task.id);
      this.insertTask(task);
      claim.created = true;
      claim.taskId = task.id;
    })();
    return claim;
  }

  private insertTrigger(trigger: Trigger, kind: "task" | "context", taskId: string | null) {
    return this.db.run(
      `INSERT OR IGNORE INTO triggers (id, source, thread_key, message_key, actor, at, payload_hash, version, kind, task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trigger.id,
        trigger.source,
        trigger.threadKey,
        trigger.messageKey,
        trigger.actor,
        trigger.at,
        trigger.payloadHash,
        trigger.version,
        kind,
        taskId,
      ],
    );
  }

  /** 编辑排队中的任务：需求按最新版本替换；已开跑的任务不接受改写 */
  updatePrompt(id: string, prompt: string): boolean {
    const res = this.db.run("UPDATE tasks SET prompt = ? WHERE id = ? AND status = 'queued'", [prompt, id]);
    return res.changes > 0;
  }

  /** 线程里还没结束的任务：同一线程的后续消息据此并进去 */
  openTaskByThread(threadKey: string): Task | null {
    const row = this.db
      .query(
        `SELECT t.* FROM tasks t JOIN triggers g ON g.task_id = t.id
         WHERE g.thread_key = ? AND t.status IN ('queued','paused')
         ORDER BY t.created_at DESC LIMIT 1`,
      )
      .get(threadKey) as Row | null;
    return row ? toTask(row) : null;
  }

  /**
   * 线程补充说明：记一条 context 触发并写进任务上下文。
   *
   * 排队任务开跑、暂停任务恢复时都会读到上下文；重复投递返回 false。
   */
  attachThreadNote(trigger: Trigger, taskId: string, note: string): boolean {
    let added = false;
    this.db.transaction(() => {
      if (this.insertTrigger(trigger, "context", taskId).changes === 0) return;
      added =
        this.db.run(
          "UPDATE tasks SET context = COALESCE(context || char(10), '') || ? WHERE id = ? AND status IN ('queued','paused')",
          [note, taskId],
        ).changes > 0;
    })();
    return added;
  }

  /** 幂等：同一事件只能登记一次 */
  claimEvent(eventId: string, taskId: string, seenAt = Date.now()): boolean {
    const res = this.db.run("INSERT OR IGNORE INTO events(event_id, task_id, seen_at) VALUES (?, ?, ?)", [
      eventId,
      taskId,
      seenAt,
    ]);
    return res.changes > 0;
  }

  /** 终态且结束时间早于 cutoff 的任务；保留策略据此删 progress 文件 */
  finishedTaskIdsBefore(cutoff: number): string[] {
    const rows = this.db
      .query(`SELECT id FROM tasks WHERE status IN ${FINISHED_IN} AND COALESCE(ended_at, created_at) < ?`)
      .all(cutoff) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /**
   * 清掉过期 events，返回删除行数。
   * 归属终态任务的按任务结束时间算；不属于任何任务的占位行（cron 每分钟占位等）按 seen_at 算，
   * 否则这类行没有任务行可依附，永远涨。
   */
  purgeEvents(cutoff: number): number {
    const byTask = this.db.run(
      `DELETE FROM events WHERE task_id IN (
         SELECT id FROM tasks WHERE status IN ${FINISHED_IN} AND COALESCE(ended_at, created_at) < ?
       )`,
      [cutoff],
    );
    const orphan = this.db.run("DELETE FROM events WHERE seen_at < ? AND task_id NOT IN (SELECT id FROM tasks)", [
      cutoff,
    ]);
    return byTask.changes + orphan.changes;
  }

  /** 回收磁盘空间；每周由 Retention 调用。WAL 模式下文件要等 checkpoint 才实际缩小 */
  vacuum(): void {
    this.db.exec("VACUUM;");
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
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

  /**
   * 该 PR 下尚未结束的评论任务：同一 PR 的工作线已有任务在跑时，新评论不另开一条。
   * 只认 PR 评论产生的任务（reply_pr 落库），取最新一条。
   */
  activeTaskByPr(pr: number, repo?: string): Task | null {
    const rows = this.db
      .query(
        `SELECT * FROM tasks WHERE reply_pr = ? AND status IN ('queued','running','paused') ORDER BY created_at DESC`,
      )
      .all(pr) as Row[];
    return rows.map(toTask).find((t) => !repo || t.replyRepo === repo) ?? null;
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

  /** 全部任务；对账要给每个任务找到归属资源，不能分页截断 */
  allTasks(): Task[] {
    const rows = this.db.query("SELECT * FROM tasks ORDER BY created_at").all() as Row[];
    return rows.map(toTask);
  }

  /** 按创建时间倒序取任务，不筛状态 */
  recentTasks(limit = 10): Task[] {
    const rows = this.db.query("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(toTask);
  }

  /** 已结束且结束时间早于 cutoff 的任务；GC 据此清理分支、工作副本与 PR */
  terminalTasksBefore(cutoff: number, limit = 300): Task[] {
    const rows = this.db
      .query(
        "SELECT * FROM tasks WHERE status IN ('succeeded','failed','cancelled') AND ended_at IS NOT NULL AND ended_at < ? ORDER BY ended_at ASC LIMIT ?",
      )
      .all(cutoff, limit) as Row[];
    return rows.map(toTask);
  }

  /** CLI 列表：按仓库、状态过滤，先筛后限 */
  listTasks(opts: { repo?: string; status?: TaskStatus; limit?: number } = {}): Task[] {
    const where: string[] = [];
    const vals: Array<string | number> = [];
    if (opts.repo) {
      where.push("repo = ?");
      vals.push(opts.repo);
    }
    if (opts.status) {
      where.push("status = ?");
      vals.push(opts.status);
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
    vals.push(Math.max(1, opts.limit ?? 20));
    return (this.db.query(sql).all(...vals) as Row[]).map(toTask);
  }

  /** 某个 PR 关联的全部任务：CLI 用 PR 号找回可续跑的任务 */
  tasksByPr(pr: number, repo?: string, limit = 20): Task[] {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE pr_url LIKE ? ORDER BY created_at DESC")
      .all(`%/pull/${pr}%`) as Row[];
    return rows
      .map(toTask)
      .filter(
        (t) =>
          t.prUrl &&
          prNumberFromIssueUrl(t.prUrl) === pr &&
          (!repo || t.prUrl.includes(`github.com/${repo}/pull/${pr}`)),
      )
      .slice(0, Math.max(1, limit));
  }

  /** 终态任务，按创建时间倒序；看板「最近完成」用，先筛后限避免被未完成任务挤掉 */
  recentFinished(limit = 5, repo?: string): Task[] {
    const rows = repo
      ? (this.db
          .query(`SELECT * FROM tasks WHERE status IN ${FINISHED_IN} AND repo = ? ORDER BY created_at DESC LIMIT ?`)
          .all(repo, limit) as Row[])
      : (this.db
          .query(`SELECT * FROM tasks WHERE status IN ${FINISHED_IN} ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as Row[]);
    return rows.map(toTask);
  }

  /** 窗口内已结束（成功/失败）的任务，按结束时间（缺失时用创建时间）判定；指标聚合的唯一查询入口 */
  finishedBetween(from: number, to: number): Task[] {
    const rows = this.db
      .query(
        `SELECT * FROM tasks WHERE status IN ('succeeded','failed')
           AND COALESCE(ended_at, created_at) BETWEEN ? AND ? ORDER BY created_at`,
      )
      .all(from, to) as Row[];
    return rows.map(toTask);
  }

  /** 与窗口有交集的任务：窗口内创建，或窗口开始时仍未结束；趋势图的队列深度需要窗口前的排队任务 */
  tasksInWindow(from: number, to: number): Task[] {
    const rows = this.db
      .query(`SELECT * FROM tasks WHERE created_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY created_at`)
      .all(to, from) as Row[];
    return rows.map(toTask);
  }

  /** 各状态任务数；看板汇总行用 */
  countByStatus(): Record<TaskStatus, number> {
    const rows = this.db.query("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all() as Array<{
      status: TaskStatus;
      n: number;
    }>;
    const counts = zeroCounts();
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }

  /** 各仓库各状态任务数；健康检查的每仓库视图用 */
  countByRepo(): Array<{ repo: string; counts: Record<TaskStatus, number> }> {
    const rows = this.db.query("SELECT repo, status, COUNT(*) AS n FROM tasks GROUP BY repo, status").all() as Array<{
      repo: string;
      status: TaskStatus;
      n: number;
    }>;
    const byRepo = new Map<string, Record<TaskStatus, number>>();
    for (const r of rows) {
      const counts = byRepo.get(r.repo) ?? zeroCounts();
      counts[r.status] = r.n;
      byRepo.set(r.repo, counts);
    }
    return [...byRepo].map(([repo, counts]) => ({ repo, counts }));
  }

  close(): void {
    this.db.close();
  }
}
