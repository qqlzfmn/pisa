import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import type { Config } from "../src/config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import type { Capabilities } from "../src/capabilities";
import { sh } from "../src/git";

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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-caps-repo-"));
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
    stateDir,
  };
}

function msg(text: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    channel: "fake",
    chatId: "c1",
    userId: "u1",
    text,
    ...over,
  };
}

const okWorker: WorkerRunner = {
  async run(_task, workdir): Promise<WorkerResult> {
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    return { ok: true, summary: "改了 out.txt", exitCode: 0 };
  },
};

describe("Router · 能力清单", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-caps-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
    cfg = makeCfg(repo, stateDir);
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function build(worker: WorkerRunner) {
    return new Router({ cfg, store, worker, deliverer: new GitDeliverer(cfg), channel, now: () => 1_000 });
  }

  test("未知档位回复可选值且不建任务", async () => {
    cfg.repos[0]!.profiles = { ui: { gui: true } };
    const router = build(okWorker);
    await router.handle(msg("/pisa 做X", { capability: "nope" }));

    expect(store.recentTasks()).toHaveLength(0);
    const text = channel.sent.at(-1)!.text;
    expect(text).toContain("未知能力档位：nope");
    expect(text).toContain("可选：ui");
  });

  test("档位落库并解析后传给 worker", async () => {
    cfg.worker.capabilities = { secrets: ["GH_TOKEN"] };
    cfg.repos[0]!.capabilities = { readPaths: ["/data/base"], domains: ["base.example"] };
    cfg.repos[0]!.profiles = { ui: { readPaths: ["/data/ui"], gui: true, domains: ["ui.example"] } };
    const seen: Array<{ task: Task; capabilities?: Capabilities }> = [];
    const capture: WorkerRunner = {
      async run(task, workdir, _onLog, _cancel, _resume, capabilities) {
        seen.push({ task, capabilities });
        writeFileSync(join(workdir, "out.txt"), "hi\n");
        return { ok: true, summary: "完成", exitCode: 0 };
      },
    };
    const router = build(capture);
    await router.handle(msg("/pisa 做X", { capability: "ui" }));
    const task = store.recentTasks()[0]!;
    expect(task.capability).toBe("ui");
    await router.drainOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.capabilities).toEqual({
      readPaths: ["/data/ui"],
      secrets: ["GH_TOKEN"],
      domains: ["ui.example"],
      gui: true,
    });
    expect(store.get(task.id)?.capability).toBe("ui");
  });

  test("越界拒绝写入任务日志并出现在回执", async () => {
    const blockedWorker: WorkerRunner = {
      async run(_task, workdir): Promise<WorkerResult> {
        writeFileSync(join(workdir, "out.txt"), "hi\n");
        return {
          ok: true,
          summary: "完成",
          exitCode: 0,
          blocked: ["bash · cat /etc/hosts：读取范围之外", "browser：GUI 工具未放行"],
        };
      },
    };
    const router = build(blockedWorker);
    await router.handle(msg("/pisa 做X"));
    const task = store.recentTasks()[0]!;
    await router.drainOnce();

    const logPath = join(stateDir, "logs", `${task.id}.log`);
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain('"stage":"blocked"');
    expect(log).toContain("cat /etc/hosts");
    expect(log).toContain("GUI 工具未放行");
    expect(channel.sent.some((s) => s.text.includes("越界被拒 2 次"))).toBe(true);
  });

  test("失败任务同样审计越界拒绝", async () => {
    const failing: WorkerRunner = {
      async run(): Promise<WorkerResult> {
        return { ok: false, summary: "", error: "boom", exitCode: 1, blocked: ["bash · curl：网络目标不在能力清单"] };
      },
    };
    const router = build(failing);
    await router.handle(msg("/pisa 做X"));
    const task = store.recentTasks()[0]!;
    await router.drainOnce();

    expect(store.get(task.id)?.status).toBe("failed");
    expect(readFileSync(join(stateDir, "logs", `${task.id}.log`), "utf8")).toContain("网络目标不在能力清单");
    const text = channel.sent.filter((s) => s.text.includes("失败")).at(-1)!.text;
    expect(text).toContain("越界被拒 1 次");
  });

  test("配置里删掉档位后执行失败并说明原因", async () => {
    cfg.repos[0]!.profiles = { ui: { gui: true } };
    const router = build(okWorker);
    await router.handle(msg("/pisa 做X", { capability: "ui" }));
    const task = store.recentTasks()[0]!;
    cfg.repos[0]!.profiles = {};
    await router.drainOnce();

    expect(store.get(task.id)?.status).toBe("failed");
    expect(store.get(task.id)?.error).toContain("未知能力档位");
    expect(channel.sent.some((s) => s.text.includes("未知能力档位"))).toBe(true);
  });
});
