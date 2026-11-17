import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatReply,
  isPullRequest,
  listComments,
  postComment,
  postIssueComment,
  prNumberFromIssueUrl,
  type Runner,
} from "../src/github";
import { GithubWatcher } from "../src/github-watcher";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer, prBody } from "../src/deliver";
import { createWorktree, sh, type ExecResult } from "../src/git";
import type { Config } from "../src/config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";

const HEADER = "**pisa** 任务完成\n\n";

function reply(code: number, out = "", err = ""): ExecResult {
  return { code, out, err };
}

/** 按顺序返回预设结果；用完后重复最后一个 */
function scripted(...replies: ExecResult[]) {
  const calls: string[][] = [];
  const runner: Runner = (args) => {
    calls.push(args);
    return replies[Math.min(calls.length - 1, replies.length - 1)]!;
  };
  return { runner, calls };
}

function apiReply(comments: Array<{ id: number; body: string; issue_url: string }>): ExecResult {
  return reply(0, comments.map((c) => JSON.stringify({ ...c, user: { login: "alice" } })).join("\n"));
}

/**
 * 评论轮询与编号类型判定共用的假 gh：按参数分派，记录全部调用。
 * prs 里的编号判定为 PR（输出非空），其余判定为普通 Issue（输出为空）。
 */
function ghRouter(
  comments: Array<{ id: number; body: string; issue_url: string }>,
  opts: { prs?: number[]; commentError?: string; typeError?: string } = {},
) {
  const calls: string[][] = [];
  const prs = new Set(opts.prs ?? []);
  const runner: Runner = (args) => {
    calls.push(args);
    const path = args[2] ?? "";
    if (path.includes("/issues/comments")) return opts.commentError ? reply(1, "", opts.commentError) : apiReply(comments);
    const m = path.match(/\/issues\/(\d+)$/);
    if (!m) return reply(1, "", `unexpected: ${args.join(" ")}`);
    if (opts.typeError) return reply(1, "", opts.typeError);
    return reply(0, prs.has(Number(m[1])) ? '{"pull_request":{"url":"https://api.github.com/repos/o/r/pulls/12"}}' : "");
  };
  return { runner, calls };
}

/** 评论列表那次调用的参数 */
function listCall(calls: string[][]): string[] {
  return calls.find((c) => (c[2] ?? "").includes("/issues/comments"))!;
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
  const dir = mkdtempSync(join(tmpdir(), "pisa-gh-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function makeCfg(repoPath: string, stateDir: string, github?: Config["github"]): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: repoPath, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    github,
    stateDir,
  };
}

const okWorker: WorkerRunner = {
  async run(): Promise<WorkerResult> {
    return { ok: true, summary: "改好了", exitCode: 0 };
  },
};

const baseTask: Task = {
  id: "t_seed",
  source: "s",
  channel: "fake",
  chatId: "c1",
  requester: "u1",
  repo: "demo",
  prompt: "上一轮",
  status: "queued",
  branch: null,
  prUrl: null,
  sessionId: null,
  baseRef: null,
  context: null,
  replyPr: null,
  replyIssue: null,
  summary: null,
  error: null,
  createdAt: 0,
  startedAt: null,
  endedAt: null,
  cancelRequested: false,
};

describe("prNumberFromIssueUrl", () => {
  test("issue 与 pull 两种路径都取到号", () => {
    expect(prNumberFromIssueUrl("https://api.github.com/repos/o/r/issues/12")).toBe(12);
    expect(prNumberFromIssueUrl("https://api.github.com/repos/o/r/pull/7")).toBe(7);
    expect(prNumberFromIssueUrl("https://api.github.com/repos/o/r/pull/7/")).toBe(7);
  });

  test("带查询串或锚点也算", () => {
    expect(prNumberFromIssueUrl("https://api.github.com/repos/o/r/issues/42?x=1")).toBe(42);
    expect(prNumberFromIssueUrl("https://github.com/o/r/pull/9#discussion")).toBe(9);
  });

  test("无关链接返回 null", () => {
    expect(prNumberFromIssueUrl("")).toBeNull();
    expect(prNumberFromIssueUrl("https://api.github.com/repos/o/r/issues")).toBeNull();
    expect(prNumberFromIssueUrl("https://api.github.com/repos/o/r/issues/0")).toBeNull();
  });
});

describe("formatReply", () => {
  test("摘要原样带出", () => {
    expect(formatReply(" 改好了 \n")).toBe(`${HEADER}改好了`);
  });

  test("超过 3000 字截断", () => {
    const body = formatReply("x".repeat(5000));
    expect(body).toBe(`${HEADER}${"x".repeat(3000)}`);
  });
});

describe("listComments / postComment", () => {
  test("拉取的参数与逐行解析", () => {
    const { runner, calls } = scripted(
      apiReply([
        { id: 11, body: "/pisa 修一下", issue_url: "https://api.github.com/repos/o/r/issues/12" },
        { id: 12, body: "只是聊天", issue_url: "https://api.github.com/repos/o/r/issues/13" },
      ]),
    );
    const res = listComments(runner, "o/r", "2026-11-17T00:00:00.000Z");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([
      { id: 11, body: "/pisa 修一下", issueUrl: "https://api.github.com/repos/o/r/issues/12", userLogin: "alice" },
      { id: 12, body: "只是聊天", issueUrl: "https://api.github.com/repos/o/r/issues/13", userLogin: "alice" },
    ]);
    expect(calls[0]).toEqual([
      "gh",
      "api",
      "repos/o/r/issues/comments?since=2026-11-17T00%3A00%3A00.000Z&per_page=100",
      "--paginate",
      "--jq",
      ".[]",
    ]);
  });

  test("命令失败与输出损坏都返回错误，不抛出", () => {
    const failed = listComments(scripted(reply(1, "", "gh: Not Found")).runner, "o/r", "2026-11-17T00:00:00.000Z");
    expect(failed).toEqual({ ok: false, error: "gh: Not Found" });

    const broken = listComments(scripted(reply(0, "{not json")).runner, "o/r", "2026-11-17T00:00:00.000Z");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error).toContain("评论解析失败");
  });

  test("回帖参数", () => {
    const { runner, calls } = scripted(reply(0));
    expect(postComment(runner, "o/r", 12, "正文")).toEqual({ ok: true, value: undefined });
    expect(calls[0]).toEqual(["gh", "pr", "comment", "12", "--repo", "o/r", "--body", "正文"]);

    const failed = postComment(scripted(reply(1, "", "no token")).runner, "o/r", 12, "正文");
    expect(failed).toEqual({ ok: false, error: "no token" });
  });

  test("Issue 回帖参数", () => {
    const { runner, calls } = scripted(reply(0));
    expect(postIssueComment(runner, "o/r", 20, "正文")).toEqual({ ok: true, value: undefined });
    expect(calls[0]).toEqual(["gh", "issue", "comment", "20", "--repo", "o/r", "--body", "正文"]);

    const failed = postIssueComment(scripted(reply(1, "", "no token")).runner, "o/r", 20, "正文");
    expect(failed).toEqual({ ok: false, error: "no token" });
  });
});

describe("isPullRequest", () => {
  test("输出非空即 PR，为空即普通 Issue", () => {
    const pr = scripted(reply(0, '{"url":"https://api.github.com/repos/o/r/pulls/12"}\n'));
    expect(isPullRequest(pr.runner, "o/r", 12)).toEqual({ ok: true, value: true });
    expect(pr.calls[0]).toEqual(["gh", "api", "repos/o/r/issues/12", "--jq", ".pull_request // empty"]);

    const issue = scripted(reply(0, "  \n"));
    expect(isPullRequest(issue.runner, "o/r", 20)).toEqual({ ok: true, value: false });
  });

  test("命令失败返回错误，不抛出", () => {
    expect(isPullRequest(scripted(reply(1, "", "gh: Not Found")).runner, "o/r", 20)).toEqual({
      ok: false,
      error: "gh: Not Found",
    });
    expect(isPullRequest(scripted(reply(1)).runner, "o/r", 20)).toEqual({ ok: false, error: "gh 退出码 1" });
  });
});

describe("GitHub 评论 → 任务", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-gh-state-"));
    store = new Store(":memory:");
    channel = new FakeChannel();
    cfg = makeCfg(repo, stateDir, { enabled: true, repo: "o/r", chatId: "c1", userId: "u1" });
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function watcher(runner: Runner, now = () => 1_700_000_000_000) {
    const router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel });
    const w = new GithubWatcher({ cfg, store, runner, now, enqueue: (m: IncomingMessage) => router.handle(m) });
    return { router, w };
  }

  test("Issue 评论建任务并绑定 Issue", async () => {
    const { runner, calls } = ghRouter([
      { id: 1, body: "/pisa 修一下登录", issue_url: "https://api.github.com/repos/o/r/issues/20" },
      { id: 2, body: "修一下登录", issue_url: "https://api.github.com/repos/o/r/issues/20" },
      { id: 3, body: "/pisax 不改", issue_url: "https://api.github.com/repos/o/r/issues/20" },
      { id: 4, body: "/pisa", issue_url: "https://api.github.com/repos/o/r/issues/20" },
    ]);
    const { w } = watcher(runner);
    await w.poll();

    const tasks = store.recentTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.prompt).toBe("修一下登录");
    expect(tasks[0]!.replyIssue).toBe(20);
    expect(tasks[0]!.replyPr).toBeNull();
    // Issue 没有父分支：从主干开新分支
    expect(tasks[0]!.baseRef).toBeNull();
    expect(tasks[0]!.branch).toBeNull();
    expect(tasks[0]!.channel).toBe("github");
    expect(tasks[0]!.chatId).toBe("c1");
    expect(tasks[0]!.requester).toBe("u1");
    expect(tasks[0]!.source).toBe("github:comment:1");
    // 启动时刻即下界
    expect(listCall(calls)[2]).toContain("since=2023-11-14T22%3A13%3A20.000Z");
    // 类型判定按编号单独查询
    expect(calls[1]).toEqual(["gh", "api", "repos/o/r/issues/20", "--jq", ".pull_request // empty"]);
  });

  test("同一评论轮询两轮只建一个任务", async () => {
    const comment = { id: 1, body: "/pisa 修一下登录", issue_url: "https://api.github.com/repos/o/r/issues/20" };
    const { runner } = ghRouter([comment]);
    const { w } = watcher(runner);
    await w.poll();
    await w.poll();
    expect(store.recentTasks().length).toBe(1);
  });

  test("类型判定失败不投递，也不推进下界", async () => {
    const comment = { id: 30, body: "/pisa 修一下", issue_url: "https://api.github.com/repos/o/r/issues/20" };
    const calls: string[][] = [];
    let typeBroken = true;
    const runner: Runner = (args) => {
      calls.push(args);
      if ((args[2] ?? "").includes("/issues/comments")) return apiReply([comment]);
      return typeBroken ? reply(1, "", "gh: rate limited") : reply(0, "");
    };
    let clock = 1_700_000_000_000;
    const { w } = watcher(runner, () => clock);

    await w.poll();
    expect(store.recentTasks().length).toBe(0);

    typeBroken = false;
    clock += 60_000;
    await w.poll();
    expect(store.recentTasks().length).toBe(1);
    expect(store.recentTasks()[0]!.replyIssue).toBe(20);
    // 失败那一轮不推进：两轮的下界相同
    expect(listCall(calls)[2]).toBe(calls[0]![2]);
  });

  test("PR 已有成功任务时接续它的分支", async () => {
    store.insertTask({ ...baseTask, id: "t_parent", prompt: "第一轮" });
    expect(store.claimQueued("t_parent", Date.now(), "pisa/t_parent")).toBe(true);
    expect(
      store.transition("t_parent", "succeeded", {
        summary: "建了 a.txt",
        prUrl: "https://github.com/o/r/pull/12",
        endedAt: Date.now(),
      }),
    ).toBe(true);

    const { runner } = ghRouter(
      [{ id: 5, body: "/pisa 再改一处", issue_url: "https://api.github.com/repos/o/r/issues/12" }],
      { prs: [12] },
    );
    const { w } = watcher(runner);
    await w.poll();

    const child = store.recentTasks().find((t) => t.prompt === "再改一处")!;
    expect(child).toBeDefined();
    expect(child.baseRef).toBe("pisa/t_parent");
    // 评论续跑落在父任务分支与原 PR 上，不新开分支/PR
    expect(child.branch).toBe("pisa/t_parent");
    expect(child.prUrl).toBe("https://github.com/o/r/pull/12");
    expect(child.context).toContain("任务号：t_parent");
    expect(child.context).toContain("#12");
    expect(child.context).toContain("PR 评论：/pisa 再改一处");
    expect(child.replyPr).toBe(12);
  });

  test("评论续跑在原分支上提交，不新建分支也不新建 PR", async () => {
    expect(sh(["git", "-C", repo, "branch", "pisa/t_parent", "main"]).code).toBe(0);
    store.insertTask({ ...baseTask, id: "t_parent", prompt: "第一轮" });
    expect(store.claimQueued("t_parent", Date.now(), "pisa/t_parent")).toBe(true);
    expect(
      store.transition("t_parent", "succeeded", {
        summary: "建了 a.txt",
        prUrl: "https://github.com/o/r/pull/12",
        endedAt: Date.now(),
      }),
    ).toBe(true);

    const editingWorker: WorkerRunner = {
      async run(_task, workdir): Promise<WorkerResult> {
        writeFileSync(join(workdir, "out.txt"), "hi\n");
        return { ok: true, summary: "再改一处", exitCode: 0 };
      },
    };
    const router = new Router({ cfg, store, worker: editingWorker, deliverer: new GitDeliverer(cfg), channel });
    await router.handle({
      eventId: "github:comment:20",
      channel: "github",
      chatId: "c1",
      userId: "u1",
      text: "/pisa 再改一处",
      continueFrom: "t_parent",
      replyPr: 12,
    });

    const child = store.recentTasks()[0]!;
    expect(child.branch).toBe("pisa/t_parent");
    expect(child.prUrl).toBe("https://github.com/o/r/pull/12");

    await router.drainOnce();

    const done = store.get(child.id)!;
    expect(done.status).toBe("succeeded");
    expect(done.branch).toBe("pisa/t_parent");
    expect(done.prUrl).toBe("https://github.com/o/r/pull/12");
    // 提交落在共享分支上，没有派生新分支
    expect(sh(["git", "-C", repo, "cat-file", "-e", "pisa/t_parent:out.txt"]).code).toBe(0);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", `pisa/${child.id}`]).code).not.toBe(0);
  });

  test("PR 没有成功任务时按普通任务处理", async () => {
    const { runner } = ghRouter(
      [{ id: 6, body: "/pisa 补一条测试", issue_url: "https://api.github.com/repos/o/r/issues/99" }],
      { prs: [99] },
    );
    const { w } = watcher(runner);
    await w.poll();

    const task = store.recentTasks()[0]!;
    expect(task.prompt).toBe("补一条测试");
    expect(task.baseRef).toBeNull();
    expect(task.context).toBeNull();
    expect(task.replyPr).toBe(99);
    expect(task.replyIssue).toBeNull();
  });

  test("拉取失败时不建任务、不推进下界；成功后推进", async () => {
    const comment = { id: 7, body: "/pisa 修一下", issue_url: "https://api.github.com/repos/o/r/issues/20" };
    const calls: string[][] = [];
    let listBroken = true;
    const runner: Runner = (args) => {
      calls.push(args);
      if (!(args[2] ?? "").includes("/issues/comments")) return reply(0, "");
      return listBroken ? reply(1, "", "gh: boom") : apiReply([comment]);
    };
    let clock = 1_700_000_000_000;
    const { w } = watcher(runner, () => clock);

    await w.poll();
    expect(store.recentTasks().length).toBe(0);

    listBroken = false;
    clock += 60_000;
    await w.poll();
    expect(store.recentTasks().length).toBe(1);
    // 失败那一轮不推进：两轮的下界相同
    expect(listCall(calls)[2]).toBe(calls[0]![2]);
    expect(calls[0]![2]).toContain("since=2023-11-14T22%3A13%3A20.000Z");
  });

  test("任务成功后向来源 PR 回帖", async () => {
    const { runner: ghRunner, calls } = scripted(reply(0));
    const router = new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
      ghRunner,
    });
    await router.handle({
      eventId: "github:comment:8",
      channel: "github",
      chatId: "c1",
      userId: "u1",
      text: "/pisa 修一下登录",
      replyPr: 12,
    });
    await router.drainOnce();

    expect(store.recentTasks()[0]!.status).toBe("succeeded");
    expect(calls).toEqual([["gh", "pr", "comment", "12", "--repo", "o/r", "--body", `${HEADER}改好了`]]);
  });

  test("任务成功后向来源 Issue 回帖", async () => {
    const { runner: ghRunner, calls } = scripted(reply(0));
    const router = new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
      ghRunner,
    });
    await router.handle({
      eventId: "github:comment:11",
      channel: "github",
      chatId: "c1",
      userId: "u1",
      text: "/pisa 修一下登录",
      replyIssue: 20,
    });
    await router.drainOnce();

    const task = store.recentTasks()[0]!;
    expect(task.status).toBe("succeeded");
    expect(task.replyIssue).toBe(20);
    expect(calls).toEqual([["gh", "issue", "comment", "20", "--repo", "o/r", "--body", `${HEADER}改好了`]]);
  });

  test("Issue 回帖失败只记日志，任务仍成功", async () => {
    const router = new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
      ghRunner: scripted(reply(1, "", "no token")).runner,
    });
    await router.handle({
      eventId: "github:comment:12",
      channel: "github",
      chatId: "c1",
      userId: "u1",
      text: "/pisa 修一下登录",
      replyIssue: 20,
    });
    await router.drainOnce();

    const task = store.recentTasks()[0]!;
    expect(task.status).toBe("succeeded");
    const log = readFileSync(join(stateDir, "logs", `${task.id}.log`), "utf8");
    expect(log).toContain("Issue #20 回帖失败");
    expect(log).toContain("no token");
  });

  test("reply_issue 落库并读回", () => {
    store.insertTask({ ...baseTask, id: "t_issue", replyIssue: 20 });
    expect(store.get("t_issue")!.replyIssue).toBe(20);
  });

  test("回帖失败只记日志，任务仍成功", async () => {
    const router = new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
      ghRunner: scripted(reply(1, "", "no token")).runner,
    });
    await router.handle({
      eventId: "github:comment:9",
      channel: "github",
      chatId: "c1",
      userId: "u1",
      text: "/pisa 修一下登录",
      replyPr: 12,
    });
    await router.drainOnce();

    const task = store.recentTasks()[0]!;
    expect(task.status).toBe("succeeded");
    const log = readFileSync(join(stateDir, "logs", `${task.id}.log`), "utf8");
    expect(log).toContain("回帖失败");
    expect(log).toContain("no token");
  });

  test("未启用 github 时不回帖", async () => {
    cfg = makeCfg(repo, stateDir);
    const { runner: ghRunner, calls } = scripted(reply(0));
    const router = new Router({
      cfg,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
      ghRunner,
    });
    await router.handle({
      eventId: "github:comment:10",
      channel: "github",
      chatId: "c1",
      userId: "u1",
      text: "/pisa 修一下登录",
      replyPr: 12,
    });
    await router.drainOnce();

    expect(store.recentTasks()[0]!.status).toBe("succeeded");
    expect(calls).toEqual([]);
  });
});

describe("prBody", () => {
  test("普通任务不带 Closes", () => {
    const body = prBody({ id: "t1", prompt: "改登录", replyIssue: null });
    expect(body).toBe("任务号：t1\n\n改登录\n\n---\n\n由 pisa 自动创建。");
  });

  test("Issue 来源追加一行，空需求也不残缺", () => {
    expect(prBody({ id: "t2", prompt: "", replyIssue: 20 })).toBe(
      "任务号：t2\n\n---\n\n由 pisa 自动创建。\n\nCloses #20",
    );
  });
});

describe("GitDeliverer 更新既有 PR", () => {
  let repo: string;
  let bare: string;
  let stateDir: string;
  let cfg: Config;

  beforeEach(() => {
    repo = makeRepo();
    bare = mkdtempSync(join(tmpdir(), "pisa-gh-bare-"));
    sh(["git", "init", "--bare", "-q", bare]);
    sh(["git", "-C", repo, "remote", "add", "origin", bare]);
    stateDir = mkdtempSync(join(tmpdir(), "pisa-gh-deliver-"));
    const base = makeCfg(repo, stateDir);
    cfg = {
      ...base,
      delivery: { ...base.delivery, push: true, pr: true },
      // 远端地址决定是否走 gh pr create；推送实际走 origin（bare）
      repos: [{ alias: "demo", path: repo, baseBranch: "main", remote: "https://github.com/o/r.git" }],
    };
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** 父任务分支 + 已挂载的工作副本，带一处改动 */
  function setup(): string {
    expect(sh(["git", "-C", repo, "branch", "pisa/parent", "main"]).code).toBe(0);
    const workdir = join(stateDir, "wt");
    expect(createWorktree(repo, workdir, "pisa/parent").code).toBe(0);
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    return workdir;
  }

  test("task.prUrl 非空时只推送分支，不新建 PR", async () => {
    const workdir = setup();
    const calls: string[] = [];
    const deliverer = new GitDeliverer(cfg, {
      hasGh: () => true,
      createPr: (_workdir, opts) => {
        calls.push(opts.head);
        return reply(0, "https://github.com/o/r/pull/99");
      },
    });

    const res = await deliverer.deliver(
      { ...baseTask, id: "t_child", branch: "pisa/parent", prUrl: "https://github.com/o/r/pull/12" },
      workdir,
      cfg.repos[0]!,
    );

    expect(calls).toEqual([]);
    expect(res.branch).toBe("pisa/parent");
    expect(res.prUrl).toBe("https://github.com/o/r/pull/12");
    expect(res.pushed).toBe(true);
    expect(sh(["git", "--git-dir", bare, "rev-parse", "--verify", "pisa/parent"]).code).toBe(0);
  });

  test("没有 prUrl 时按原有逻辑创建 PR", async () => {
    const workdir = setup();
    const calls: string[] = [];
    const deliverer = new GitDeliverer(cfg, {
      hasGh: () => true,
      createPr: (_workdir, opts) => {
        calls.push(opts.head);
        return reply(0, "https://github.com/o/r/pull/99");
      },
    });

    const res = await deliverer.deliver({ ...baseTask, id: "t_new", branch: "pisa/parent" }, workdir, cfg.repos[0]!);

    expect(calls).toEqual(["pisa/parent"]);
    expect(res.prUrl).toBe("https://github.com/o/r/pull/99");
  });

  test("Issue 来源的任务在 PR 正文追加 Closes", async () => {
    const workdir = setup();
    const bodies: string[] = [];
    const deliverer = new GitDeliverer(cfg, {
      hasGh: () => true,
      createPr: (_workdir, opts) => {
        bodies.push(opts.body);
        return reply(0, "https://github.com/o/r/pull/99");
      },
    });

    const res = await deliverer.deliver(
      { ...baseTask, id: "t_issue", prompt: "", branch: "pisa/parent", replyIssue: 20 },
      workdir,
      cfg.repos[0]!,
    );

    expect(bodies).toEqual(["任务号：t_issue\n\n---\n\n由 pisa 自动创建。\n\nCloses #20"]);
    expect(res.prUrl).toBe("https://github.com/o/r/pull/99");
  });
});
