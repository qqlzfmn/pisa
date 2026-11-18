import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { Deliverer } from "../src/deliver";
import type { Runner } from "../src/github";
import { GithubWatcher } from "../src/github-watcher";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { sh, type ExecResult } from "../src/git";
import type { ChannelAdapter, DeliveryResult, IncomingMessage, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";

const PR_SHA = "a".repeat(40);
const PR_SHA_NEXT = "b".repeat(40);
const DIFF = "@@ -1 +1 @@\n-hello\n+hello world";

function reply(code: number, out = "", err = ""): ExecResult {
  return { code, out, err };
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-review-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function makeCfg(repoPath: string, stateDir: string, review: boolean): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: repoPath, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    github: {
      enabled: true,
      repos: [{ repo: "o/r", chatId: "c1", userId: "u1" }],
      review: { enabled: review },
    },
    stateDir,
  };
}

/** 假 gh：评论为空；open PR 列表与 diff 结果可逐次变更 */
function reviewGh(prs: Array<{ number: number; headRefOid: string; title: string; body: string; url: string }>, failDiffTimes = 0) {
  const calls: string[][] = [];
  let diffFailures = failDiffTimes;
  const runner: Runner = (args) => {
    calls.push(args);
    const path = args[2] ?? "";
    if (path === "list") return reply(0, JSON.stringify(prs));
    if (path === "diff") {
      if (diffFailures > 0) {
        diffFailures -= 1;
        return reply(1, "", "gh: rate limited");
      }
      return reply(0, DIFF);
    }
    if (path.startsWith("repos/")) return reply(0, "");
    return reply(1, "", `unexpected: ${args.join(" ")}`);
  };
  return { runner, calls };
}

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: Array<{ chatId: string; text: string }> = [];
  async start(): Promise<void> {}
  async send(chatId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ chatId, text });
    return { messageId: String(this.sent.length) };
  }
  async stop(): Promise<void> {}
}

const okWorker: WorkerRunner = {
  async run(): Promise<WorkerResult> {
    return { ok: true, summary: "实现正确", exitCode: 0 };
  },
};

/** 评审任务不应交付：任何调用都算失败 */
class NoDelivery implements Deliverer {
  calls = 0;
  async deliver(): Promise<DeliveryResult> {
    this.calls += 1;
    throw new Error("评审任务不应交付");
  }
  effectHandlers() {
    return {
      push: async () => {
        this.calls += 1;
        throw new Error("评审任务不应推送");
      },
      pr: async () => {
        this.calls += 1;
        throw new Error("评审任务不应建 PR");
      },
    };
  }
}

describe("GitHub PR 自动评审", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-review-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function setup(review: boolean, runner: Runner, deliverer: Deliverer = new NoDelivery()) {
    const cfg = makeCfg(repo, stateDir, review);
    const router = new Router({ cfg, store, worker: okWorker, deliverer, channel, ghRunner: runner });
    const w = new GithubWatcher({ cfg, store, runner, now: () => 1_700_000_000_000, enqueue: (m: IncomingMessage) => router.handle(m) });
    return { cfg, router, deliverer, w };
  }

  test("开启后为开放 PR 建只读评审任务，提示词带 PR 与 diff", async () => {
    const { runner } = reviewGh([
      { number: 3, headRefOid: PR_SHA, title: "修复登录", body: "说明", url: "https://github.com/o/r/pull/3" },
    ]);
    const { w } = setup(true, runner);
    await w.poll();

    const task = store.recentTasks()[0]!;
    expect(store.recentTasks().length).toBe(1);
    expect(task.kind).toBe("review");
    expect(task.replyPr).toBe(3);
    expect(task.replyRepo).toBe("o/r");
    expect(task.prompt).toContain("PR #3");
    expect(task.prompt).toContain(PR_SHA);
    expect(task.prompt).toContain("修复登录");
    expect(task.prompt).toContain("+hello world");
    expect(task.prompt).toContain("只读评审");
  });

  test("同一 PR 同一 head SHA 只评审一次", async () => {
    const prs = [{ number: 3, headRefOid: PR_SHA, title: "修复登录", body: "", url: "" }];
    const { runner, calls } = reviewGh(prs);
    const { w } = setup(true, runner);

    await w.poll();
    await w.poll();
    expect(store.recentTasks().length).toBe(1);
    // 第二轮已命中触发记录，不再拉 diff
    expect(calls.filter((c) => c[2] === "diff").length).toBe(1);
  });

  test("head SHA 变化后再评审一次", async () => {
    const prs = [{ number: 3, headRefOid: PR_SHA, title: "修复登录", body: "", url: "" }];
    const { runner } = reviewGh(prs);
    const { w } = setup(true, runner);

    await w.poll();
    prs[0]!.headRefOid = PR_SHA_NEXT;
    await w.poll();

    const tasks = store.recentTasks();
    expect(tasks.length).toBe(2);
    expect(tasks.filter((t) => t.kind === "review").length).toBe(2);
    expect(tasks.some((t) => t.prompt.includes(PR_SHA_NEXT))).toBe(true);
  });

  test("重建 Watcher 后同一 head SHA 不重复评审", async () => {
    const { runner } = reviewGh([
      { number: 3, headRefOid: PR_SHA, title: "修复登录", body: "", url: "" },
    ]);
    await setup(true, runner).w.poll();
    // 新实例沿用同一 store，触发记录仍在
    await setup(true, runner).w.poll();
    expect(store.recentTasks().length).toBe(1);
  });

  test("关闭开关时不拉 PR 列表，也不建任务", async () => {
    const { runner, calls } = reviewGh([
      { number: 3, headRefOid: PR_SHA, title: "修复登录", body: "", url: "" },
    ]);
    const { w } = setup(false, runner);
    await w.poll();

    expect(calls.some((c) => c[2] === "list")).toBe(false);
    expect(store.recentTasks().length).toBe(0);
  });

  test("diff 拉取失败不建任务，下一轮重试", async () => {
    const { runner } = reviewGh(
      [{ number: 3, headRefOid: PR_SHA, title: "修复登录", body: "", url: "" }],
      1,
    );
    const { w } = setup(true, runner);

    await w.poll();
    expect(store.recentTasks().length).toBe(0);

    await w.poll();
    expect(store.recentTasks().length).toBe(1);
    expect(store.recentTasks()[0]!.kind).toBe("review");
  });

  test("评审任务不交付、丢弃工作副本改动，结论以评论回帖", async () => {
    const editingWorker: WorkerRunner = {
      async run(_task, workdir): Promise<WorkerResult> {
        writeFileSync(join(workdir, "sneaky.txt"), "不应保留\n");
        return { ok: true, summary: "结论：需要修改，边界条件缺失。", exitCode: 0 };
      },
    };
    const cfg = makeCfg(repo, stateDir, true);
    const deliverer = new NoDelivery();
    const calls: string[][] = [];
    const ghRunner: Runner = (args) => {
      calls.push(args);
      if (args[1] === "api") return reply(0, "");
      return reply(0);
    };
    const router = new Router({ cfg, store, worker: editingWorker, deliverer, channel, ghRunner });

    await router.handle({
      eventId: "github:review:o/r:3:" + PR_SHA,
      channel: "github",
      chatId: "c1",
      userId: "u1",
      text: "/pisa 评审这个 PR",
      kind: "review",
      replyRepo: "o/r",
      replyPr: 3,
      threadKey: "github:o/r:pull:3",
      messageKey: PR_SHA,
      version: PR_SHA,
      actor: "pisa",
    });
    await router.drainOnce();

    const task = store.recentTasks()[0]!;
    expect(task.status).toBe("succeeded");
    expect(task.kind).toBe("review");
    expect(task.branch).toBeNull();
    expect(task.prUrl).toBeNull();
    expect(deliverer.calls).toBe(0);
    expect(existsSync(join(stateDir, "worktrees", task.id))).toBe(false);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", `pisa/${task.id}`]).code).not.toBe(0);

    const comment = calls.find((c) => c[1] === "pr" && c[2] === "comment");
    expect(comment).toBeDefined();
    const body = comment![comment!.length - 1]!;
    expect(body.startsWith("**pisa** 评审结论\n\n")).toBe(true);
    expect(body).toContain("结论：需要修改");
    expect(body).not.toContain("**pisa** 任务完成");
  });
});
