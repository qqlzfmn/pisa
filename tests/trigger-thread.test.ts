import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { GithubWatcher } from "../src/github-watcher";
import { sh } from "../src/git";
import type { Config } from "../src/config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import type { Runner } from "../src/github";

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: Array<{ chatId: string; text: string }> = [];
  private seq = 0;
  async start(): Promise<void> {}
  async send(chatId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ chatId, text });
    this.seq += 1;
    return { messageId: String(this.seq) };
  }
  async stop(): Promise<void> {}
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

function triggers(store: Store): TriggerRow[] {
  return store.db.query("SELECT * FROM triggers ORDER BY rowid").all() as TriggerRow[];
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

const okWorker: WorkerRunner = {
  async run(): Promise<WorkerResult> {
    return { ok: true, summary: "ok", exitCode: 0 };
  },
};

describe("Trigger 身份与线程归属", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;
  let clock: number;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
    clock = 1_700_000_000_000;
    cfg = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: ["u1"], repos: ["demo"] },
      repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      stateDir,
    };
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function router(): Router {
    return new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
      now: () => (clock += 1000),
    });
  }

  function msg(text: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
    return { eventId: "evt-1", channel: "telegram", chatId: "c1", userId: "u1", text, ...over };
  }

  function seedTask(over: Partial<Task> & { id: string }): Task {
    const { id, ...rest } = over;
    const task: Task = {
      id,
      source: `seed:${id}`,
      channel: "telegram",
      chatId: "c1",
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
      createdAt: 0,
      startedAt: null,
      endedAt: null,
      lane: "base",
      cancelRequested: false,
      ...rest,
    };
    store.insertTask(task);
    return task;
  }

  test("重复投递只建一个任务，触发器记录来源/线程/消息/触发者/载荷指纹", async () => {
    const r = router();
    const m = msg("/pisa 修登录", { threadKey: "tg:c1" });
    await r.handle(m);
    await r.handle(m);

    expect(store.recentTasks()).toHaveLength(1);
    const rows = triggers(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "telegram",
      thread_key: "tg:c1",
      message_key: "evt-1",
      actor: "u1",
      version: "",
      kind: "task",
      task_id: store.recentTasks()[0]!.id,
    });
    expect(rows[0]!.payload_hash).toMatch(/^[0-9a-f]{32}$/);
  });

  test("同一事件声明两个线程 → 两个任务，各自记录线程", async () => {
    const r = router();
    await r.handle(msg("/pisa 修登录", { threadKey: "tg:a" }));
    await r.handle(msg("/pisa 修登录", { threadKey: "tg:b" }));

    expect(store.recentTasks()).toHaveLength(2);
    expect(triggers(store).map((t) => t.thread_key)).toEqual(["tg:a", "tg:b"]);
  });

  test("同线程的后续消息并进未结束任务的上下文，不新建任务", async () => {
    const r = router();
    await r.handle(msg("/pisa 修登录", { threadKey: "tg:a" }));
    // 群聊里不带触发词就是普通聊天，只有线程归属能接住它
    await r.handle(msg("顺便补一条测试", { threadKey: "tg:a", eventId: "evt-2", isDirect: false }));
    // 重复投递的同一句聊天不重复追加
    await r.handle(msg("顺便补一条测试", { threadKey: "tg:a", eventId: "evt-2", isDirect: false }));

    expect(store.recentTasks()).toHaveLength(1);
    const task = store.recentTasks()[0]!;
    expect(task.context).toBe("补充说明：顺便补一条测试");
    const rows = triggers(store);
    expect(rows.filter((t) => t.kind === "context").map((t) => t.task_id)).toEqual([task.id]);
  });

  test("同一消息的新版本挂回原任务，按 version 留痕并更新排队正文", async () => {
    const r = router();
    await r.handle(msg("/pisa 修登录", { threadKey: "tg:a", version: "2026-11-18T10:00:00Z" }));
    await r.handle(msg("/pisa 修登录并补测试", { threadKey: "tg:a", version: "2026-11-18T10:01:00Z" }));

    expect(store.recentTasks()).toHaveLength(1);
    const task = store.recentTasks()[0]!;
    expect(task.prompt).toBe("修登录并补测试");

    const rows = triggers(store);
    expect(rows).toHaveLength(2);
    expect(rows.map((t) => t.version)).toEqual(["2026-11-18T10:00:00Z", "2026-11-18T10:01:00Z"]);
    expect(rows.filter((t) => t.kind === "task")).toHaveLength(1);
    expect(rows.filter((t) => t.kind === "context").map((t) => t.task_id)).toEqual([task.id]);
  });

  test("已开跑的任务不接受编辑正文，但编辑仍留痕", async () => {
    const r = router();
    await r.handle(msg("/pisa 修登录", { threadKey: "tg:a", version: "1" }));
    const task = store.recentTasks()[0]!;
    expect(store.claimQueued(task.id, clock, "pisa/running")).toBe(true);

    await r.handle(msg("/pisa 修别的", { threadKey: "tg:a", version: "2" }));

    expect(store.get(task.id)?.prompt).toBe("修登录");
    expect(triggers(store)).toHaveLength(2);
    expect(triggers(store).filter((t) => t.kind === "context")).toHaveLength(1);
  });

  test("回复任务消息续跑，子任务触发器线程为 task:<父任务号>", async () => {
    store.linkMessage("c1", "77", "t_parent");
    seedTask({ id: "t_parent", branch: "pisa/parent" });

    await router().handle(msg("再补一处", { eventId: "evt-2", replyToMessageId: 77 }));

    const child = store.recentTasks()[0]!;
    expect(child.prompt).toBe("再补一处");
    expect(child.baseRef).toBe("pisa/parent");
    expect(triggers(store).find((t) => t.task_id === child.id)).toMatchObject({
      thread_key: "task:t_parent",
      message_key: "evt-2",
    });
  });

  test("旧库补齐触发器：任务不丢，重放旧事件不再建任务", async () => {
    const file = join(stateDir, "legacy.sqlite");
    const old = new Store(file);
    old.insertTask({
      ...seedTaskFixture(),
      id: "t_legacy",
      source: "telegram:c9:77",
      chatId: "c9",
      prompt: "旧需求",
      createdAt: 111,
    });
    old.close();

    store.close();
    store = new Store(file);
    expect(store.recentTasks()).toHaveLength(1);
    expect(triggers(store)).toEqual([
      expect.objectContaining({
        source: "telegram",
        thread_key: "telegram:c9:telegram:c9:77",
        message_key: "telegram:c9:77",
        actor: "u1",
        kind: "task",
        task_id: "t_legacy",
      }),
    ]);

    await router().handle(msg("/pisa 旧需求", { eventId: "telegram:c9:77", chatId: "c9" }));
    expect(store.recentTasks()).toHaveLength(1);
  });

  test("GitHub 评论编辑：同一评论的新 updated_at 不新建任务", async () => {
    const comments: Array<Record<string, unknown>> = [];
    const runner: Runner = (args) => {
      const path = args[2] ?? "";
      if (path.includes("/issues/comments")) {
        return { code: 0, out: comments.map((c) => JSON.stringify(c)).join("\n"), err: "" };
      }
      const m = path.match(/\/issues\/(\d+)$/);
      if (!m) return { code: 1, out: "", err: `unexpected: ${args.join(" ")}` };
      // 普通 Issue：没有 pull_request 字段
      return { code: 0, out: "", err: "" };
    };
    cfg = {
      ...cfg,
      github: { enabled: true, repo: "o/r", chatId: "c1", userId: "u1", intervalSec: 60 },
    };
    const watcher = new GithubWatcher({ cfg, store, enqueue: (m) => router().handle(m), runner, now: () => clock });

    comments.push({
      id: 501,
      body: "/pisa 修 CI",
      issue_url: "https://api.github.com/repos/o/r/issues/12",
      updated_at: "2026-11-18T10:00:00Z",
      user: { login: "alice" },
    });
    await watcher.poll();
    expect(store.recentTasks()).toHaveLength(1);

    comments[0]!.body = "/pisa 修 CI 并补测试";
    comments[0]!.updated_at = "2026-11-18T10:05:00Z";
    await watcher.poll();

    expect(store.recentTasks()).toHaveLength(1);
    expect(store.recentTasks()[0]!.prompt).toBe("修 CI 并补测试");
    const rows = triggers(store);
    expect(rows.map((t) => t.version)).toEqual(["2026-11-18T10:00:00Z", "2026-11-18T10:05:00Z"]);
    expect(rows[0]).toMatchObject({ thread_key: "github:o/r:issue:12", message_key: "501", actor: "alice" });
  });
});

/** 旧库行只有 tasks 表的列，触发器靠 Store 构造时补齐 */
function seedTaskFixture(): Task {
  return {
    id: "t_fixture",
    source: "seed",
    channel: "telegram",
    chatId: "c1",
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
    createdAt: 0,
    startedAt: null,
    endedAt: null,
    lane: "base",
    cancelRequested: false,
  };
}
