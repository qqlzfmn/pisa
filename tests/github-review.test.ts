import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GithubWatcher } from "../src/github-watcher";
import { sh, type ExecResult } from "../src/git";
import { replyMarker, type Runner } from "../src/github";
import type { Config } from "../src/config";
import type { ChannelAdapter, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import type { Deliverer } from "../src/deliver";

const REPO = "o/r";
const DIFF = "diff --git a/a.ts b/a.ts\n+const x = 1;\n";

function reply(code: number, out = "", err = ""): ExecResult {
  return { code, out, err };
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
    github: { enabled: true, repo: REPO, chatId: "c1", userId: "u1", review: { enabled: review } },
    stateDir,
  };
}

interface PrFixture {
  number: number;
  headRefName: string;
  headRefOid: string;
  title: string;
  baseRefName: string;
  url: string;
}

/** 假 gh：PR 列表 / diff / 评论接口按参数分派，记录全部调用 */
function ghRouter(prs: PrFixture[], opts: { diffError?: string } = {}) {
  const calls: string[][] = [];
  const runner: Runner = (args) => {
    calls.push(args);
    if (args[1] === "pr" && args[2] === "list") return reply(0, JSON.stringify(prs));
    if (args[1] === "pr" && args[2] === "diff") {
      return opts.diffError ? reply(1, "", opts.diffError) : reply(0, DIFF);
    }
    return reply(0);
  };
  return { runner, calls };
}

const reviewWorker: WorkerRunner = {
  async run(task: Task, workdir: string): Promise<WorkerResult> {
    expect(task.mode).toBe("review");
    expect(workdir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(join(workdir, ".git"))).toBe(false);
    return { ok: true, summary: "有建议：补一个边界测试", exitCode: 0 };
  },
};

const noDeliver: Deliverer = {
  async deliver(): Promise<never> {
    throw new Error("评审任务不应交付");
  },
  effectHandlers() {
    return {
      push: async () => {
        throw new Error("评审任务不应推送");
      },
      pr: async () => {
        throw new Error("评审任务不应创建 PR");
      },
    };
  },
};

let repo = "";
let stateDir = "";
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

function build(cfg: Config, runner: Runner) {
  const router = new Router({
    cfg,
    store,
    worker: reviewWorker,
    deliverer: noDeliver,
    channel,
    ghRunner: runner,
  });
  const watcher = new GithubWatcher({
    cfg,
    store,
    runner,
    enqueue: (m) => router.handle(m),
  });
  return { router, watcher };
}

describe("PR 自动评审", () => {
  test("开关关闭：不拉 PR 列表，不建任务", async () => {
    const cfg = makeCfg(repo, stateDir, false);
    const { runner, calls } = ghRouter([{ number: 7, headRefName: "feat", headRefOid: "abc", title: "t", baseRefName: "main", url: "u" }]);
    const { watcher } = build(cfg, runner);
    await watcher.poll();

    expect(calls.some((c) => c[1] === "pr" && c[2] === "list")).toBe(false);
    expect(store.recentTasks()).toHaveLength(0);
  });

  test("检测到未评审 PR：建只读评审任务，正文带 diff 与约束", async () => {
    const cfg = makeCfg(repo, stateDir, true);
    const { runner } = ghRouter([
      { number: 7, headRefName: "feat", headRefOid: "abc123", title: "加登录", baseRefName: "main", url: "https://github.com/o/r/pull/7" },
    ]);
    const { watcher } = build(cfg, runner);
    await watcher.poll();

    const tasks = store.recentTasks();
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.mode).toBe("review");
    expect(task.replyPr).toBe(7);
    expect(task.replyRepo).toBe(REPO);
    expect(task.branch).toBeNull();
    expect(task.prompt).toContain("只读评审");
    expect(task.prompt).toContain("+const x = 1;");
    expect(task.prompt).toContain("abc123");
  });

  test("同一 head SHA 只评审一次：重复轮询与重启都命中同一条记录", async () => {
    const cfg = makeCfg(repo, stateDir, true);
    const { runner } = ghRouter([
      { number: 7, headRefName: "feat", headRefOid: "abc123", title: "加登录", baseRefName: "main", url: "u" },
    ]);
    const { watcher } = build(cfg, runner);
    await watcher.poll();
    await watcher.poll();

    // 新实例模拟重启：去重记录在 triggers 表，不靠内存
    const second = build(cfg, runner);
    await second.watcher.poll();

    const tasks = store.recentTasks();
    expect(tasks).toHaveLength(1);
    expect(store.triggerByMessage("github:o/r:pull:7:review", "abc123")).not.toBeNull();
  });

  test("head SHA 变化后重新评审", async () => {
    const cfg = makeCfg(repo, stateDir, true);
    const prs: PrFixture[] = [
      { number: 7, headRefName: "feat", headRefOid: "abc123", title: "加登录", baseRefName: "main", url: "u" },
    ];
    const { runner } = ghRouter(prs);
    const { watcher } = build(cfg, runner);
    await watcher.poll();

    prs[0]!.headRefOid = "def456";
    await watcher.poll();

    const tasks = store.recentTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.source).sort()).toEqual(["github:review:o/r:7:abc123", "github:review:o/r:7:def456"]);
  });

  test("diff 拉取失败不建任务，下一轮成功后补上", async () => {
    const cfg = makeCfg(repo, stateDir, true);
    const pr: PrFixture = {
      number: 7,
      headRefName: "feat",
      headRefOid: "abc123",
      title: "加登录",
      baseRefName: "main",
      url: "u",
    };
    const failing = ghRouter([pr], { diffError: "gh: boom" });
    const first = build(cfg, failing.runner);
    await first.watcher.poll();
    expect(store.recentTasks()).toHaveLength(0);

    const ok = ghRouter([pr]);
    const second = build(cfg, ok.runner);
    await second.watcher.poll();
    expect(store.recentTasks()).toHaveLength(1);
  });

  test("评审完成：回帖到 PR，不建分支、不交付", async () => {
    const cfg = makeCfg(repo, stateDir, true);
    const { runner, calls } = ghRouter([
      { number: 7, headRefName: "feat", headRefOid: "abc123", title: "加登录", baseRefName: "main", url: "u" },
    ]);
    const { router, watcher } = build(cfg, runner);
    await watcher.poll();
    await router.drainOnce();

    const task = store.recentTasks()[0]!;
    expect(task.status).toBe("succeeded");
    expect(task.branch).toBeNull();
    expect(task.summary).toBe("有建议：补一个边界测试");

    const posted = calls.find((c) => c[1] === "pr" && c[2] === "comment");
    expect(posted).toBeDefined();
    expect(posted!.join(" ")).toContain("**pisa** 评审完成");
    expect(posted!.join(" ")).toContain(replyMarker(task.id, "pr"));

    expect(sh(["git", "-C", repo, "branch", "--list", "pisa/*"]).out.trim()).toBe("");
    expect(existsSync(join(stateDir, "worktrees"))).toBe(false);
  });
});
