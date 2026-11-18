import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEB, type Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { createWebhookHandler } from "../src/webhook";
import type { ChannelAdapter, DeliveryReceipt } from "../src/types";
import { sh } from "../src/git";

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: Array<{ chatId: string; text: string }> = [];
  async start(): Promise<void> {}
  async send(chatId: string, text: string): Promise<DeliveryReceipt> {
    this.sent.push({ chatId, text });
    return { messageId: String(this.sent.length) };
  }
  async stop(): Promise<void> {}
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-webhook-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function makeCfg(repoPath: string, stateDir: string): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: repoPath, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    web: { ...DEFAULT_WEB, enabled: true, userId: "u1", chatId: "web" },
    stateDir,
  };
}

const TOKEN = "abc123";
const PROMPT = "解决改进项 seed:idem-outbox：引入 Outbox/Effect 表";

let root: string;
let store: Store;
let channel: FakeChannel;
let handler: (req: Request) => Promise<Response>;

function post(body: unknown, token = TOKEN): Promise<Response> {
  return handler(
    new Request("http://127.0.0.1:8799/event", {
      method: "POST",
      headers: { "content-type": "application/json", "x-pisa-token": token },
      body: JSON.stringify(body),
    }),
  );
}

async function dispatch(eventId: string): Promise<{ taskId: string | null }> {
  const res = await post({ prompt: PROMPT, eventId });
  expect(res.status).toBe(200);
  return (await res.json()) as { taskId: string | null };
}

function taskCount(): number {
  return (store.db.query("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pisa-webhook-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const cfg = makeCfg(makeRepo(), stateDir);
  store = new Store(":memory:");
  channel = new FakeChannel();
  const router = new Router({ cfg, store, worker: { run: async () => ({ ok: true, summary: "", exitCode: 0 }) }, deliverer: new GitDeliverer(cfg), channel });
  handler = createWebhookHandler({
    token: TOKEN,
    chatId: "hook",
    userId: "u1",
    store,
    submit: (m) => router.handle(m),
  });
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("webhook 派单", () => {
  test("回执带 taskId，events 里能按 eventId 反查到它", async () => {
    const { taskId } = await dispatch("auto:impl:a:1");
    expect(taskId).toBeTruthy();
    expect(taskCount()).toBe(1);
    const row = store.db.query("SELECT task_id FROM events WHERE event_id = ?").get("auto:impl:a:1") as
      | { task_id: string }
      | undefined;
    expect(row?.task_id).toBe(taskId!);
  });

  test("同一 eventId 重投只建一个任务", async () => {
    const first = await dispatch("auto:impl:a:1");
    const second = await dispatch("auto:impl:a:1");
    expect(second.taskId).toBe(first.taskId);
    expect(taskCount()).toBe(1);
  });

  test("同一需求换 eventId 重投，任务还在排队时不重复派单", async () => {
    const first = await dispatch("auto:impl:a:1");
    const second = await dispatch("auto:impl:a:2");
    expect(second.taskId).toBe(first.taskId);
    expect(taskCount()).toBe(1);
    expect(channel.sent.some((s) => s.text.includes("不重复派单"))).toBe(true);
  });

  test("同一需求已有执行中的任务时，第二次派单被拒绝", async () => {
    const first = await dispatch("auto:impl:a:1");
    expect(store.claimQueued(first.taskId!, Date.now(), "pisa/t1")).toBe(true);

    const second = await dispatch("auto:impl:a:2");
    expect(second.taskId).toBe(first.taskId);
    expect(taskCount()).toBe(1);
    expect(store.get(second.taskId!)?.status).toBe("running");
  });

  test("原任务结束后同一需求可以再派", async () => {
    const first = await dispatch("auto:impl:a:1");
    store.transition(first.taskId!, "cancelled");

    const second = await dispatch("auto:impl:a:2");
    expect(second.taskId).not.toBe(first.taskId);
    expect(taskCount()).toBe(2);
  });

  test("非任务命令不建任务，taskId 为空", async () => {
    const res = await post({ prompt: "/pisa status", eventId: "auto:status:1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId: string | null };
    expect(body.taskId).toBeNull();
    expect(taskCount()).toBe(0);
  });

  test("鉴权失败与缺参数的边界", async () => {
    expect((await post({ prompt: PROMPT }, "wrong")).status).toBe(403);
    expect((await post({})).status).toBe(400);
  });
});
