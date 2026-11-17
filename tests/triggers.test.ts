import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { legacyThreadKey, payloadHash, threadKeyOf } from "../src/trigger";
import type { Task } from "../src/types";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    source: "telegram:9:1",
    channel: "telegram",
    chatId: "9",
    requester: "u1",
    repo: "demo",
    prompt: "旧需求",
    status: "queued",
    branch: null,
    prUrl: null,
    sessionId: null,
    baseRef: null,
    context: null,
    replyPr: null,
    replyIssue: null,
    replyRepo: null,
    summary: null,
    error: null,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
    ...over,
  };
}

function trigger(id: string, taskId: string, over: Partial<Parameters<Store["claimTrigger"]>[0]> = {}) {
  return {
    id,
    source: "telegram",
    threadKey: "telegram:9",
    actor: "u1",
    payloadHash: payloadHash("修登录"),
    at: 10,
    newTaskId: taskId,
    ...over,
  };
}

describe("payloadHash", () => {
  test("折叠空白后同文同摘要", () => {
    expect(payloadHash("修 登录\n")).toBe(payloadHash("修  登录"));
  });

  test("正文不同摘要不同", () => {
    expect(payloadHash("修登录")).not.toBe(payloadHash("修登录并补测试"));
  });
});

describe("threadKeyOf", () => {
  test("入口给出线程键就用它", () => {
    expect(threadKeyOf({ channel: "telegram", eventId: "telegram:1:2", threadKey: "telegram:1" })).toBe("telegram:1");
  });

  test("缺省时事件自成线程", () => {
    expect(threadKeyOf({ channel: "webhook", eventId: "webhook:5" })).toBe("webhook:webhook:5");
  });
});

describe("legacyThreadKey", () => {
  const base = { channel: "telegram", chatId: "9", source: "telegram:9:1", replyRepo: null, replyPr: null, replyIssue: null };

  test("telegram 按聊天", () => {
    expect(legacyThreadKey(base)).toBe("telegram:9");
  });

  test("github 按仓库与编号", () => {
    expect(legacyThreadKey({ ...base, channel: "github", source: "github:comment:o/r:5", replyRepo: "o/r", replyIssue: 3 })).toBe(
      "github:o/r:3",
    );
  });

  test("cron 等自带入口前缀的事件自成线程", () => {
    expect(legacyThreadKey({ ...base, channel: "cron", source: "cron:daily:2026-11-18T09:00" })).toBe(
      "cron:daily:2026-11-18T09:00",
    );
  });
});

describe("Store.claimTrigger", () => {
  test("首次触发新建", () => {
    const store = new Store(":memory:");
    store.insertTask(task("t_1"));
    expect(store.claimTrigger(trigger("telegram:9:1", "t_1"))).toEqual({ kind: "new", taskId: "t_1" });
    expect(store.triggersOf("t_1")).toHaveLength(1);
    store.close();
  });

  test("同一事件重复投递返回已有任务", () => {
    const store = new Store(":memory:");
    store.insertTask(task("t_1"));
    store.claimTrigger(trigger("telegram:9:1", "t_1"));
    expect(store.claimTrigger(trigger("telegram:9:1", "t_2"))).toEqual({ kind: "duplicate", taskId: "t_1" });
    expect(store.triggersOf("t_1")).toHaveLength(1);
    store.close();
  });

  test("同线程同人同正文归并到未结束的任务", () => {
    const store = new Store(":memory:");
    store.insertTask(task("t_1", { status: "running" }));
    store.claimTrigger(trigger("telegram:9:1", "t_1"));
    expect(store.claimTrigger(trigger("telegram:9:2", "t_2"))).toEqual({ kind: "duplicate", taskId: "t_1" });
    store.close();
  });

  test("任务已结束则同正文重新成任务", () => {
    const store = new Store(":memory:");
    store.insertTask(task("t_1", { status: "succeeded" }));
    store.claimTrigger(trigger("telegram:9:1", "t_1"));
    expect(store.claimTrigger(trigger("telegram:9:2", "t_2"))).toEqual({ kind: "new", taskId: "t_2" });
    store.close();
  });

  test("不同线程同正文互不归并", () => {
    const store = new Store(":memory:");
    store.insertTask(task("t_1"));
    store.claimTrigger(trigger("telegram:9:1", "t_1"));
    expect(store.claimTrigger(trigger("telegram:8:1", "t_2", { threadKey: "telegram:8" }))).toEqual({
      kind: "new",
      taskId: "t_2",
    });
    store.close();
  });

  test("同一事件改正文加版本，不换任务", () => {
    const store = new Store(":memory:");
    store.insertTask(task("t_1"));
    store.claimTrigger(trigger("telegram:9:1", "t_1"));
    expect(store.claimTrigger(trigger("telegram:9:1", "t_2", { payloadHash: payloadHash("修登录并补测试") }))).toEqual({
      kind: "version",
      taskId: "t_1",
      version: 2,
    });
    expect(store.triggersOf("t_1").map((t) => t.version)).toEqual([1, 2]);
    store.close();
  });

  test("任务已结束时改正文仍算重复", () => {
    const store = new Store(":memory:");
    store.insertTask(task("t_1", { status: "succeeded" }));
    store.claimTrigger(trigger("telegram:9:1", "t_1"));
    expect(store.claimTrigger(trigger("telegram:9:1", "t_2", { payloadHash: payloadHash("修登录并补测试") }))).toEqual({
      kind: "duplicate",
      taskId: "t_1",
    });
    store.close();
  });
});

describe("触发器回填", () => {
  test("旧任务补记录，重开不翻倍，任务数据不丢", () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-db-"));
    const path = join(dir, "pisa.db");
    try {
      const first = new Store(path);
      first.insertTask(task("t_1", { status: "succeeded" }));
      first.close();

      const second = new Store(path);
      const rows = second.triggersOf("t_1");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe("telegram:9:1");
      expect(rows[0]!.source).toBe("telegram");
      expect(rows[0]!.threadKey).toBe("telegram:9");
      expect(rows[0]!.actor).toBe("u1");
      expect(rows[0]!.payloadHash).toBe(payloadHash("旧需求"));
      expect(second.get("t_1")!.prompt).toBe("旧需求");
      expect(second.get("t_1")!.status).toBe("succeeded");
      // 回填记录同样参与去重
      expect(second.claimTrigger(trigger("telegram:9:1", "t_2"))).toEqual({ kind: "duplicate", taskId: "t_1" });
      second.close();

      const third = new Store(path);
      expect(third.triggersOf("t_1")).toHaveLength(1);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("老库（无触发器表、缺新列）打开后回填，任务数据不丢", () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-old-"));
    const path = join(dir, "old.db");
    try {
      const db = new Database(path, { create: true });
      db.exec(`CREATE TABLE tasks (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL,
        requester TEXT NOT NULL, repo TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
        branch TEXT, pr_url TEXT, summary TEXT, error TEXT,
        created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0)`);
      db.run(
        `INSERT INTO tasks (id, source, channel, chat_id, requester, repo, prompt, status, branch, pr_url, summary, error, created_at, started_at, ended_at, cancel_requested)
         VALUES ('t_old', 'github:comment:o/r:5', 'github', 'gh', 'u1', 'demo', '修一下', 'succeeded', 'pisa/t_old', 'https://github.com/o/r/pull/3', 'ok', NULL, 5, 6, 7, 0)`,
      );
      db.close();

      const store = new Store(path);
      const rows = store.triggersOf("t_old");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe("github:comment:o/r:5");
      expect(rows[0]!.threadKey).toBe("github:comment:o/r:5");
      expect(rows[0]!.payloadHash).toBe(payloadHash("修一下"));
      const task = store.get("t_old")!;
      expect(task.prompt).toBe("修一下");
      expect(task.status).toBe("succeeded");
      expect(task.prUrl).toBe("https://github.com/o/r/pull/3");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
