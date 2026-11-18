import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { webhookHandler, WEBHOOK_EVENT_PREFIX } from "../src/webhook";
import { sh } from "../src/git";
import type { Config } from "../src/config";
import type { ChannelAdapter, WorkerResult } from "../src/types";

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: Array<{ chatId: string; text: string }> = [];
  async start(): Promise<void> {}
  private seq = 0;
  async send(chatId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ chatId, text });
    this.seq += 1;
    return { messageId: String(this.seq) };
  }
  async stop(): Promise<void> {}
}

const TOKEN = "test-webhook-token";
const NOW = 1_700_000_000_000;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

describe("webhook 事件入口", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;
  let handler: (req: Request) => Promise<Response>;

  const events = (): string[] =>
    (store.db.query("SELECT event_id FROM events ORDER BY event_id").all() as Array<{ event_id: string }>).map(
      (r) => r.event_id,
    );

  function post(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request("http://127.0.0.1:8799/event", {
      method: "POST",
      headers: { "x-pisa-token": TOKEN, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
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
    const worker = {
      async run(): Promise<WorkerResult> {
        return { ok: true, summary: "ok", exitCode: 0 };
      },
    };
    const router = new Router({ cfg, store, worker, deliverer: new GitDeliverer(cfg), channel });
    handler = webhookHandler({
      token: TOKEN,
      chatId: "c1",
      userId: "u1",
      handle: (m) => router.handle(m),
      now: () => NOW,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("token 缺失或不等（含长度不同）都 403，不派活", async () => {
    const missing = new Request("http://127.0.0.1:8799/event", { method: "POST", body: JSON.stringify({ prompt: "x" }) });
    expect((await handler(missing)).status).toBe(403);
    expect((await handler(post({ prompt: "x" }, { "x-pisa-token": `${TOKEN.slice(0, -1)}X` }))).status).toBe(403);
    expect((await handler(post({ prompt: "x" }, { "x-pisa-token": "short" }))).status).toBe(403);

    expect(store.recentTasks()).toHaveLength(0);
    expect(events()).toEqual([]);
  });

  test("非 webhook: 前缀的 eventId 返回 400，且不占 events 键", async () => {
    for (const eventId of ["cron:morning:2026-11-18T09:00", "github:comment:owner/repo:1", "telegram:1:2", "no-prefix"]) {
      const res = await handler(post({ prompt: "抢占", eventId }));
      expect(res.status).toBe(400);
    }
    expect(store.recentTasks()).toHaveLength(0);
    expect(events()).toEqual([]);
  });

  test("自己的 eventId 建任务并回执，重投只建一个", async () => {
    const body = { prompt: "跑测试并修掉失败", eventId: `${WEBHOOK_EVENT_PREFIX}ci:12345` };
    const first = await handler(post(body));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, eventId: `${WEBHOOK_EVENT_PREFIX}ci:12345` });

    expect(store.recentTasks()).toHaveLength(1);
    expect(events()).toEqual([`${WEBHOOK_EVENT_PREFIX}ci:12345`]);
    expect(channel.sent.at(-1)?.text).toContain("已接单");

    const again = await handler(post({ ...body, prompt: "跑测试并修掉失败（重投）" }));
    expect(again.status).toBe(200);
    expect(store.recentTasks()).toHaveLength(1);
  });

  test("省略 eventId 时自动生成 webhook:<ts>:<rand>", async () => {
    const res = await handler(post({ prompt: "自动事件号" }));
    expect(res.status).toBe(200);
    const { eventId } = (await res.json()) as { eventId: string };
    expect(eventId).toMatch(/^webhook:1700000000000:[a-z0-9]{6}$/);
    expect(events()).toEqual([eventId]);
    expect(store.recentTasks()).toHaveLength(1);
  });

  test("Content-Length 超过 64 KiB 返回 413，不派活", async () => {
    const forged = await handler(
      post({ prompt: "小正文" }, { "content-length": String(70 * 1024) }),
    );
    expect(forged.status).toBe(413);

    const big = await handler(post({ prompt: "x".repeat(64 * 1024) }));
    expect(big.status).toBe(413);

    expect(store.recentTasks()).toHaveLength(0);
    expect(events()).toEqual([]);
  });

  test("非 POST 返回 405", async () => {
    const res = await handler(new Request("http://127.0.0.1:8799/event", { method: "GET" }));
    expect(res.status).toBe(405);
  });
});
