import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReview, listOpenPulls, reviewPrompt, type PullSummary } from "../src/github";
import { GithubWatcher } from "../src/github-watcher";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { sh, type ExecResult } from "../src/git";
import type { Config } from "../src/config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";

function reply(code: number, out = "", err = ""): ExecResult {
  return { code, out, err };
}

/** 开放 PR 列表的输出：与 `--jq '.[]'` 一致，一行一个 PR 对象 */
function pullsReply(pulls: Array<{ number: number; sha: string; title?: string; base?: string; draft?: boolean }>) {
  return reply(
    0,
    pulls
      .map((p) =>
        JSON.stringify({
          number: p.number,
          title: p.title ?? `PR ${p.number}`,
          draft: p.draft === true,
          head: { sha: p.sha },
          base: { ref: p.base ?? "main" },
        }),
      )
      .join("\n"),
  );
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

/** 带裸远程的仓库，并在裸远程上留一条 refs/pull/1/head */
function makeRepoWithPull(): { repo: string; bare: string; headSha: string } {
  const repo = makeRepo();
  const bare = mkdtempSync(join(tmpdir(), "pisa-review-bare-"));
  sh(["git", "init", "-q", "--bare", "-b", "main"], bare);
  sh(["git", "-C", repo, "remote", "add", "origin", bare]);
  sh(["git", "-C", repo, "push", "-q", "origin", "main"]);

  const wt = mkdtempSync(join(tmpdir(), "pisa-review-wt-"));
  sh(["git", "-C", repo, "worktree", "add", "-q", "-b", "feature", wt, "main"]);
  writeFileSync(join(wt, "pr-file.txt"), "from pr\n");
  sh(["git", "-C", wt, "add", "-A"]);
  sh(["git", "-C", wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "pr"]);
  const headSha = sh(["git", "-C", wt, "rev-parse", "HEAD"]).out;
  sh(["git", "-C", wt, "push", "-q", "origin", "HEAD:refs/pull/1/head"]);
  sh(["git", "-C", repo, "worktree", "remove", "--force", wt]);
  sh(["git", "-C", repo, "branch", "-D", "feature"]);
  sh(["git", "-C", repo, "fetch", "-q", "origin"]);
  return { repo, bare, headSha };
}

function makeCfg(repoPath: string, stateDir: string, github?: Config["github"], repos?: Config["repos"]): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo", "site"] },
    repos: repos ?? [{ alias: "demo", path: repoPath, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: true, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    github,
    stateDir,
  };
}

const okWorker: WorkerRunner = {
  async run(): Promise<WorkerResult> {
    return { ok: true, summary: "结论：可以合并", exitCode: 0 };
  },
};

/**
 * 评审轮询与回帖共用的假 gh：开放 PR 列表来自 live.pulls，评论拉取与讨论串查询都返回空。
 * 记录全部调用，便于断言「开关关闭时一次都没调」。
 */
function ghFake(live: { pulls: Array<{ number: number; sha: string; title?: string; base?: string; draft?: boolean }> }) {
  const calls: string[][] = [];
  const runner = (args: string[]): ExecResult => {
    calls.push(args);
    const path = args[2] ?? "";
    if (path.includes("/pulls?state=open")) return pullsReply(live.pulls);
    if (path.includes("/issues/comments")) return reply(0, "");
    if (/\/issues\/\d+\/comments$/.test(path)) return reply(0, "");
    if (args[1] === "pr" && args[2] === "comment") return reply(0);
    return reply(1, "", `unexpected: ${args.join(" ")}`);
  };
  return { runner, calls };
}

const SAMPLE: PullSummary = { number: 1, headSha: "a".repeat(40), title: "加登录", baseRef: "main", draft: false };

describe("listOpenPulls", () => {
  test("参数、逐行解析与草稿标记", () => {
    let args: string[] = [];
    const runner = (a: string[]): ExecResult => {
      args = a;
      return pullsReply([
        { number: 7, sha: "b".repeat(40), title: "改接口", base: "develop" },
        { number: 8, sha: "c".repeat(40), title: "草稿", draft: true },
      ]);
    };
    const res = listOpenPulls(runner, "o/r");
    expect(args).toEqual(["gh", "api", "repos/o/r/pulls?state=open&per_page=100", "--paginate", "--jq", ".[]"]);
    expect(res).toEqual({
      ok: true,
      value: [
        { number: 7, headSha: "b".repeat(40), title: "改接口", baseRef: "develop", draft: false },
        { number: 8, headSha: "c".repeat(40), title: "草稿", baseRef: "main", draft: true },
      ],
    });
  });

  test("命令失败与坏行都返回错误，不抛出", () => {
    expect(listOpenPulls(() => reply(1, "", "gh: Not Found"), "o/r")).toEqual({ ok: false, error: "gh: Not Found" });
    const broken = listOpenPulls(() => reply(0, "{oops"), "o/r");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain("PR 解析失败");
  });
});

describe("reviewPrompt / formatReview", () => {
  test("提示词带 PR 号、标题、基线、head 提交与查看差异的方式", () => {
    const text = reviewPrompt("o/r", SAMPLE);
    expect(text).toContain("自动评审 PR #1（o/r）");
    expect(text).toContain("标题：加登录");
    expect(text).toContain("目标分支：main");
    expect(text).toContain(`head 提交：${SAMPLE.headSha}`);
    expect(text).toContain("gh pr diff 1 --repo o/r");
    expect(text).toContain("只读");
  });

  test("回帖抬头带短提交，正文截断到 3000 字", () => {
    expect(formatReview(1, "abcdef1234567", " 结论 \n")).toBe(
      "**pisa** 自动评审 · PR #1 @ abcdef1\n\n结论",
    );
    const long = formatReview(2, "a".repeat(40), "x".repeat(5000));
    expect(long).toBe(`**pisa** 自动评审 · PR #2 @ aaaaaaa\n\n${"x".repeat(3000)}`);
  });
});

describe("评审轮询", () => {
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

  function setup(
    gh: Config["github"],
    runner: (args: string[]) => ExecResult,
    worker: WorkerRunner = okWorker,
    repos?: Config["repos"],
  ) {
    const cfg = makeCfg(repo, stateDir, gh, repos);
    const router = new Router({ cfg, store, worker, deliverer: new GitDeliverer(cfg), channel, ghRunner: runner });
    const w = new GithubWatcher({
      cfg,
      store,
      runner,
      now: () => 1_700_000_000_000,
      enqueue: (m: IncomingMessage) => router.handle(m),
    });
    return { cfg, router, w };
  }

  const reviewRepos = (alias?: string): Config["github"] => ({
    enabled: true,
    review: { enabled: true },
    repos: [{ repo: "o/r", chatId: "c1", userId: "u1", ...(alias ? { alias } : {}) }],
  });

  test("新 PR 建一条评审任务，同一 head 只投一次，换提交再投", async () => {
    const live = { pulls: [{ number: 1, sha: "a".repeat(40) }] };
    const { runner } = ghFake(live);
    const { w } = setup(reviewRepos(), runner);

    await w.poll();
    await w.poll();
    let tasks = store.recentTasks().filter((t) => t.mode === "review");
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.replyPr).toBe(1);
    expect(task.baseRef).toBe("a".repeat(40));
    expect(task.branch).toBeNull();
    expect(task.source).toBe(`github:pr-review:o/r:1:${"a".repeat(40)}`);
    expect(task.chatId).toBe("c1");
    expect(task.requester).toBe("u1");
    expect(task.prompt).toContain("自动评审 PR #1");

    // 新 head 提交：同一 PR 重新评审
    live.pulls = [{ number: 1, sha: "b".repeat(40) }];
    await w.poll();
    tasks = store.recentTasks().filter((t) => t.mode === "review");
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.baseRef)).toContain("b".repeat(40));
  });

  test("重启后内存去重清空，事件认领仍挡住重复评审", async () => {
    const sha = "f".repeat(40);
    const gh = reviewRepos();
    const first = setup(gh, ghFake({ pulls: [{ number: 4, sha }] }).runner);
    await first.w.poll();
    expect(store.recentTasks()).toHaveLength(1);

    // 新的 watcher 相当于进程重启：内存集合为空，靠 store 里已认领的事件号去重
    const second = setup(gh, ghFake({ pulls: [{ number: 4, sha }] }).runner);
    await second.w.poll();
    expect(store.recentTasks()).toHaveLength(1);
  });

  test("开关关闭：不拉 PR 列表也不建任务", async () => {
    const { runner, calls } = ghFake({ pulls: [{ number: 1, sha: "c".repeat(40) }] });
    const { w } = setup({ enabled: true, repos: [{ repo: "o/r", chatId: "c1", userId: "u1" }] }, runner);

    await w.poll();
    expect(calls.filter((c) => (c[2] ?? "").includes("/pulls?state=open"))).toHaveLength(0);
    expect(store.recentTasks()).toHaveLength(0);
  });

  test("草稿 PR 跳过", async () => {
    const { w } = setup(reviewRepos(), ghFake({ pulls: [{ number: 2, sha: "d".repeat(40), draft: true }] }).runner);
    await w.poll();
    expect(store.recentTasks()).toHaveLength(0);
  });

  test("配置别名时任务落到别名仓库", async () => {
    const repos: Config["repos"] = [
      { alias: "demo", path: repo, baseBranch: "main" },
      { alias: "site", path: repo, baseBranch: "main" },
    ];
    const { w } = setup(reviewRepos("site"), ghFake({ pulls: [{ number: 3, sha: "e".repeat(40) }] }).runner, okWorker, repos);
    await w.poll();
    expect(store.recentTasks()[0]!.repo).toBe("site");
  });

  test("PR 列表拉取失败只记日志，不影响评论轮询", async () => {
    const calls: string[][] = [];
    const runner = (args: string[]): ExecResult => {
      calls.push(args);
      const path = args[2] ?? "";
      if (path.includes("/pulls?state=open")) return reply(1, "", "gh: rate limited");
      if (path.includes("/issues/comments")) return reply(0, "");
      return reply(0);
    };
    const { w } = setup(reviewRepos(), runner);
    await w.poll();
    expect(store.recentTasks()).toHaveLength(0);
    expect(calls.some((c) => (c[2] ?? "").includes("/issues/comments"))).toBe(true);
  });
});

describe("评审任务的执行", () => {
  let repo: string;
  let bare: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let headSha: string;

  beforeEach(() => {
    ({ repo, bare, headSha } = makeRepoWithPull());
    stateDir = mkdtempSync(join(tmpdir(), "pisa-review-run-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("检出 PR 代码、只读跑完、回帖、不留分支与推送", async () => {
    const gh = { pulls: [{ number: 1, sha: headSha }] };
    const { runner, calls } = ghFake(gh);
    const cfg = makeCfg(repo, stateDir, {
      enabled: true,
      review: { enabled: true },
      repos: [{ repo: "o/r", chatId: "c1", userId: "u1", alias: "demo" }],
    });
    let seen = "";
    const worker: WorkerRunner = {
      async run(
        _task: Task,
        workdir: string,
        _log: (line: string) => void,
        _cancel: () => boolean,
      ): Promise<WorkerResult> {
        seen = readFileSync(join(workdir, "pr-file.txt"), "utf8");
        // 评审模型即使写文件，也不该被保存或推送
        writeFileSync(join(workdir, "written-by-review.txt"), "x\n");
        return { ok: true, summary: "结论：可以合并", exitCode: 0 };
      },
    };
    const router = new Router({ cfg, store, worker, deliverer: new GitDeliverer(cfg), channel, ghRunner: runner });
    const w = new GithubWatcher({
      cfg,
      store,
      runner,
      now: () => 1_700_000_000_000,
      enqueue: (m: IncomingMessage) => router.handle(m),
    });

    await w.poll();
    const task = store.recentTasks()[0]!;
    expect(task.mode).toBe("review");
    expect(task.status).toBe("queued");
    await router.drainOnce();

    // 工作副本确实检出了 PR 的 head 提交
    expect(seen).toBe("from pr\n");

    const done = store.get(task.id)!;
    expect(done.status).toBe("succeeded");
    expect(done.summary).toBe("结论：可以合并");
    expect(done.branch).toBeNull();

    // 副本删除，改动没有落到主工作区
    expect(existsSync(join(stateDir, "worktrees", task.id))).toBe(false);
    expect(existsSync(join(repo, "written-by-review.txt"))).toBe(false);

    // 没有分支、没有推送
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", `refs/heads/pisa/${task.id}`]).code).not.toBe(0);
    const bareRefs = sh(["git", "-C", bare, "for-each-ref", "--format=%(refname)"]).out;
    expect(bareRefs).not.toContain("pisa/");
    expect(bareRefs).toContain("refs/heads/main");

    // 结论回帖到 PR，抬头带 PR 号与短提交
    const bodies = calls.filter((c) => c[1] === "pr" && c[2] === "comment").map((c) => c[c.indexOf("--body") + 1] ?? "");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toStartWith(`**pisa** 自动评审 · PR #1 @ ${headSha.slice(0, 7)}`);
    expect(bodies[0]).toContain("结论：可以合并");
    expect(bodies[0]).toContain(`<!-- pisa:reply task=${task.id} on=pr -->`);

    // 回复里也有结论
    expect(channel.sent.some((m) => m.text.includes("评审完成"))).toBe(true);
  });
});
