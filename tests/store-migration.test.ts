import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import type { Task } from "../src/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pisa-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(id: string, priority?: Task["priority"]): Task {
  return {
    id,
    source: `seed:${id}`,
    channel: "fake",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "迁移测试",
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
    createdAt: 0,
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
    mode: "work",
    ...(priority ? { priority } : {}),
  };
}

describe("tasks.priority 迁移", () => {
  test("旧库缺 priority 列时补列，已有任务读回 auto", () => {
    const file = join(dir, "pisa.db");
    const first = new Store(file);
    first.insertTask(seed("t_old"));
    first.close();

    const raw = new Database(file);
    raw.run("ALTER TABLE tasks DROP COLUMN priority");
    raw.close();

    const store = new Store(file);
    expect(store.get("t_old")?.priority).toBe("auto");
    expect(store.nextQueued("human")).toBeNull();

    store.insertTask(seed("t_new", "human"));
    expect(store.nextQueued("human")?.id).toBe("t_new");
    // 无参仍是全局最早，不按 priority 过滤
    expect(store.nextQueued()?.id).toBe("t_old");
    store.close();
  });
});
