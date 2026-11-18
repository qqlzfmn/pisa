import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import type { Config } from "../src/config";
import { sh } from "../src/git";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: string[] = [];
  async start(): Promise<void> {}
  async send(_c: string, text: string): Promise<{}> {
    this.sent.push(text);
    return {};
  }
  async stop(): Promise<void> {}
}

/** 可用闸门放行的 Worker：用来把槽位占住，不依赖真实时间 */
class GateWorker implements WorkerRunner {
  private gates: Array<() => void> = [];

  async run(): Promise<WorkerResult> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.gates.push(resolve);
    await promise;
    return { ok: true, summary: "done", exitCode: 0 };
  }

  releaseAll(): void {
    for (const gate of this.gates) gate();
    this.gates = [];
  }
}

describe("槽位与人类优先通道", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;
  let worker: GateWorker;
  let router: Router;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "pisa-slot-repo-"));
    sh(["git", "init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "README.md"), "hello\n");
    sh(["git", "-C", repo, "add", "-A"]);
    sh(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    stateDir = mkdtempSync(join(tmpdir(), "pisa-slot-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
    worker = new GateWorker();
    cfg = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: ["u1"], repos: ["demo"] },
      repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 2, humanConcurrency: 1 },
      delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "p@l" },
      channels: { cli: true },
      stateDir,
    };
    router = new Router({ cfg, store, worker, deliverer: new GitDeliverer(cfg), channel });
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  const msg = (text: string): IncomingMessage => ({
    eventId: `e-${Math.random().toString(36).slice(2)}`,
    channel: "fake",
    chatId: "c1",
    userId: "u1",
    text,
  });

  /** 造一个带分支的已完成任务当续跑父任务 */
  async function finishedParent(): Promise<Task> {
    await router.handle(msg("/pisa 父任务"));
    const parent = store.recentTasks(1)[0]!;
    sh(["git", "-C", repo, "branch", "pisa/parent", "main"]);
    store.transition(parent.id, "running", { branch: "pisa/parent", startedAt: Date.now() });
    store.transition(parent.id, "succeeded", { summary: "x", endedAt: Date.now() });
    return store.get(parent.id)!;
  }

  test("满槽时人类追问可进，新任务仍排队，看板给出槽位与原因", async () => {
    const parent = await finishedParent();
    await router.handle(msg("/pisa 长任务 A"));
    await router.handle(msg("/pisa 长任务 B"));
    router.fill();
    expect(store.runningTasks().map((t) => t.prompt)).toEqual(["长任务 A", "长任务 B"]);

    await router.handle(msg(`/pisa continue ${parent.id} 追问一句`));
    const followUp = store.queuedTasks()[0]!;
    expect(followUp.priority).toBe("human");
    router.fill();
    expect(store.get(followUp.id)!.status).toBe("running");
    expect(router.slots()).toEqual({ task: { used: 2, limit: 2 }, human: { used: 1, limit: 1 } });

    await router.handle(msg("/pisa 新任务 C"));
    const fresh = store.recentTasks(1)[0]!;
    router.fill();
    expect(store.get(fresh.id)!.status).toBe("queued");

    await router.handle(msg("/pisa status"));
    const board = channel.sent.at(-1)!;
    expect(board).toContain("槽位：任务 2/2 · 人类追问 1/1");
    expect(board).toContain("原因：任务槽位已满（2/2）");

    worker.releaseAll();
    await router.stop(2000);
  });

  test("人类追问槽满后第二条追问排队，普通任务仍走任务槽", async () => {
    const parent = await finishedParent();
    await router.handle(msg(`/pisa continue ${parent.id} 追问一`));
    await router.handle(msg(`/pisa continue ${parent.id} 追问二`));
    router.fill();

    const queuedFollowUp = store.queuedTasks()[0]!;
    expect(queuedFollowUp.priority).toBe("human");
    expect(store.get(queuedFollowUp.id)!.status).toBe("queued");
    expect(router.slots()).toEqual({ task: { used: 0, limit: 2 }, human: { used: 1, limit: 1 } });

    await router.handle(msg("/pisa status"));
    const board = channel.sent.at(-1)!;
    expect(board).toContain("槽位：任务 0/2 · 人类追问 1/1");
    expect(board).toContain("原因：人类追问槽位已满（1/1）");

    await router.handle(msg("/pisa 新任务 N"));
    router.fill();
    const normal = store.runningTasks().find((t) => t.prompt === "新任务 N");
    expect(normal?.priority).toBe("normal");
    expect(router.slots()).toEqual({ task: { used: 1, limit: 2 }, human: { used: 1, limit: 1 } });

    worker.releaseAll();
    await router.stop(2000);
  });
});
