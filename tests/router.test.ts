import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { parseCommand, type Config } from "../src/config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { sh, changedFiles, createWorktree } from "../src/git";

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
  const dir = mkdtempSync(join(tmpdir(), "pisa-repo-"));
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

describe("parseCommand", () => {
  test("普通任务", () => {
    expect(parseCommand("/pisa 修一下登录", "/pisa")).toEqual({ kind: "task", body: "修一下登录" });
  });
  test("续跑命令", () => {
    expect(parseCommand("/pisa continue t_1 再改一下", "/pisa")).toEqual({ kind: "continue", body: "t_1 再改一下" });
  });

  test("恢复命令", () => {
    expect(parseCommand("/pisa resume t_1", "/pisa")).toEqual({ kind: "resume", body: "t_1" });
  });

  test("取消与帮助", () => {
    expect(parseCommand("/pisa cancel t_1", "/pisa")).toEqual({ kind: "cancel", body: "t_1" });
    expect(parseCommand("/pisa", "/pisa")).toEqual({ kind: "help", body: "" });
  });
  test("没有触发词不响应", () => {
    expect(parseCommand("你好", "/pisa")).toBeNull();
  });
});

describe("Router", () => {
  let repo: string;
  let stateDir: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-state-"));
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
    return new Router({ cfg, store, worker, deliverer: new GitDeliverer(cfg), channel });
  }

  test("私聊不带触发词也能建任务", async () => {
    const router = build(okWorker);
    await router.handle(msg("把登录超时改成 30 分钟", { isDirect: true }));
    expect(store.recent()[0]?.prompt).toBe("把登录超时改成 30 分钟");
  });

  test("群聊仍然需要触发词", async () => {
    const router = build(okWorker);
    await router.handle(msg("把登录超时改成 30 分钟", { isDirect: false }));
    expect(store.recent().length).toBe(0);
  });

  test("私聊 /status 不走任务", async () => {
    const router = build(okWorker);
    await router.handle(msg("/status", { isDirect: true }));
    expect(store.recent().length).toBe(0);
    expect(channel.sent.some((s) => s.text.includes("还没有任务"))).toBe(true);
  });

  test("非白名单用户被拒，且不建任务", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 做点事", { userId: "stranger" }));
    expect(store.recent().length).toBe(0);
    expect(channel.sent[0]?.text).toContain("无权限");
  });

  test("同一事件重复投递只建一个任务", async () => {
    const router = build(okWorker);
    const m = msg("/pisa 做点事");
    await router.handle(m);
    await router.handle(m);
    expect(store.recent().length).toBe(1);
  });

  test("完整链路：接单 → 执行 → 提交到分支，主分支不变", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 新建 out.txt"));
    expect(store.recent()[0]?.status).toBe("queued");

    const ran = await router.drainOnce();
    expect(ran).toBe(true);

    const task = store.recent()[0]!;
    expect(task.status).toBe("succeeded");
    expect(task.branch).toBe(`pisa/${task.id}`);

    // 分支有文件
    expect(sh(["git", "-C", repo, "cat-file", "-e", `${task.branch}:out.txt`]).code).toBe(0);
    // 主分支没有
    expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).not.toBe(0);
    // 工作副本已清理
    expect(existsSync(join(stateDir, "worktrees", task.id))).toBe(false);
    // 回执
    expect(channel.sent.some((s) => s.text.includes("完成"))).toBe(true);
  });

  test("Worker 失败时任务 failed，不产生分支提交", async () => {
    const failWorker: WorkerRunner = {
      async run(): Promise<WorkerResult> {
        return { ok: false, summary: "", error: "编译失败", exitCode: 1 };
      },
    };
    const router = build(failWorker);
    await router.handle(msg("/pisa 改坏它"));
    await router.drainOnce();

    const task = store.recent()[0]!;
    expect(task.status).toBe("failed");
    expect(task.error).toContain("编译失败");
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", task.branch!]).code).not.toBe(0);
  });

  test("changedFiles 正确解析未暂存改动", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "solo.txt"), "1\n");
    expect(changedFiles(dir)).toEqual(["solo.txt"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("并发 2：两个任务同时开始", async () => {
    cfg.worker.concurrency = 2;
    const starts: number[] = [];
    const slow: WorkerRunner = {
      async run(_t, workdir): Promise<WorkerResult> {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, 150));
        writeFileSync(join(workdir, "out.txt"), "hi\n");
        return { ok: true, summary: "ok", exitCode: 0 };
      },
    };
    const router = build(slow);
    await router.handle(msg("/pisa 任务 A"));
    await router.handle(msg("/pisa 任务 B"));

    const t0 = Date.now();
    await router.drainOnce();
    const total = Date.now() - t0;

    expect(starts.length).toBe(2);
    expect(Math.abs(starts[0]! - starts[1]!)).toBeLessThan(200);
    expect(total).toBeLessThan(400);
    expect(store.recent().every((t) => t.status === "succeeded")).toBe(true);
  });

  test("并发 1：第二个任务等第一个结束", async () => {
    cfg.worker.concurrency = 1;
    const spans: Array<[number, number]> = [];
    const slow: WorkerRunner = {
      async run(_t, workdir): Promise<WorkerResult> {
        const s = Date.now();
        await new Promise((r) => setTimeout(r, 80));
        spans.push([s, Date.now()]);
        writeFileSync(join(workdir, "out.txt"), "hi\n");
        return { ok: true, summary: "ok", exitCode: 0 };
      },
    };
    const router = build(slow);
    await router.handle(msg("/pisa 任务 A"));
    await router.handle(msg("/pisa 任务 B"));
    await router.drainOnce();

    expect(spans.length).toBe(2);
    expect(spans[1]![0]).toBeGreaterThanOrEqual(spans[0]![1] - 5);
  });

  test("continue 继承上一个任务的会话", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 第一个任务"));
    const parent = store.recent()[0]!;
    store.transition(parent.id, "running", { branch: "pisa/parent", startedAt: Date.now() });
    store.transition(parent.id, "succeeded", { summary: "建了 a.txt", endedAt: Date.now() });

    await router.handle(msg(`/pisa continue ${parent.id} 再改一处`));
    const child = store.recent()[0]!;
    expect(child.baseRef).toBe("pisa/parent");
    expect(child.context).toContain(parent.id);
    expect(child.prompt).toBe("再改一处");
  });

  test("continue 找不到任务时拒绝", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa continue t_missing 再改"));
    expect(store.recent().length).toBe(0);
    expect(channel.sent[0]?.text).toContain("找不到任务");
  });

  test("merge 把任务分支合入主干", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 新建 out.txt"));
    await router.drainOnce();
    const id = store.recent()[0]!.id;

    await router.handle(msg(`/pisa merge ${id}`));
    expect(channel.sent.some((s) => s.text.includes("已合并"))).toBe(true);
    expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).toBe(0);
  });

  test("回复任务消息自动续跑该任务", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 第一轮"));
    await router.drainOnce();
    const parent = store.recent()[0]!;
    store.linkMessage("c1", "9001", parent.id);

    await router.handle(msg("再加一行", { replyToMessageId: 9001 }));
    const child = store.recent()[0]!;
    expect(child.id).not.toBe(parent.id);
    expect(child.baseRef).toBe(parent.branch);
    expect(child.prompt).toBe("再加一行");
  });

  test("开启 push 后分支真的推到远程", async () => {
    const bare = mkdtempSync(join(tmpdir(), "pisa-bare-"));
    sh(["git", "init", "--bare", "-q", bare]);
    sh(["git", "-C", repo, "remote", "add", "origin", bare]);
    const cfg2: Config = {
      ...cfg,
      delivery: { ...cfg.delivery, push: true },
      repos: [{ alias: "demo", path: repo, baseBranch: "main", remote: bare }],
    };
    const router2 = new Router({
      cfg: cfg2,
      store,
      worker: okWorker,
      deliverer: new GitDeliverer(cfg2),
      channel,
    });

    await router2.handle(msg("/pisa 推一个提交"));
    await router2.drainOnce();
    const t = store.recent()[0]!;
    expect(t.status).toBe("succeeded");
    expect(sh(["git", "--git-dir", bare, "rev-parse", "--verify", t.branch!]).code).toBe(0);

    sh(["git", "-C", repo, "remote", "remove", "origin"]);
    rmSync(bare, { recursive: true, force: true });
  });

  test("status 列出最近任务", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 做点事"));
    await router.handle(msg("/pisa status"));
    expect(channel.sent.some((s) => s.text.includes("最近") && s.text.includes("queued"))).toBe(true);
  });

  test("排队中的任务可以取消", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 待办"));
    const id = store.recent()[0]!.id;
    await router.handle(msg(`/pisa cancel ${id}`));

    expect(store.get(id)?.status).toBe("cancelled");
    expect(await router.drainOnce()).toBe(false);
  });

  test("启动恢复：可恢复的转 paused，其余 failed，工作副本保留", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 任务 A"));
    await router.handle(msg("/pisa 任务 B"));
    const a = store.recent().find((t) => t.prompt === "任务 A")!;
    const b = store.recent().find((t) => t.prompt === "任务 B")!;

    const workdirA = join(stateDir, "worktrees", a.id);
    expect(store.claimQueued(a.id, Date.now(), `pisa/${a.id}`)).toBe(true);
    expect(createWorktree(repo, workdirA, `pisa/${a.id}`).code).toBe(0);
    store.setSessionId(a.id, "sess-a");

    expect(store.claimQueued(b.id, Date.now(), `pisa/${b.id}`)).toBe(true);

    expect(router.recoverInterrupted()).toEqual({ paused: 1, failed: 1 });
    expect(store.get(a.id)?.status).toBe("paused");
    expect(store.get(b.id)?.status).toBe("failed");
    expect(store.get(b.id)?.error).toContain("中断");
    expect(existsSync(workdirA)).toBe(true);
  });

  test("resume 复用工作副本，Worker 再次执行且任务成功", async () => {
    const calls: Array<{ id: string; resume: boolean | undefined }> = [];
    const resumable: WorkerRunner = {
      async run(task, workdir, _onLog, _cancel, resume) {
        calls.push({ id: task.id, resume });
        writeFileSync(join(workdir, "out.txt"), "hi\n");
        return { ok: true, summary: "继续完成", exitCode: 0 };
      },
    };
    const router = build(resumable);
    await router.handle(msg("/pisa 新建 out.txt"));
    const task = store.recent()[0]!;
    const branch = `pisa/${task.id}`;
    const workdir = join(stateDir, "worktrees", task.id);

    // 模拟进程中断：工作副本已建、会话已落库、任务被恢复流程置为 paused
    expect(store.claimQueued(task.id, Date.now(), branch)).toBe(true);
    expect(createWorktree(repo, workdir, branch).code).toBe(0);
    store.setSessionId(task.id, "sess-1");
    expect(store.transition(task.id, "paused")).toBe(true);

    await router.handle(msg(`/pisa resume ${task.id}`));
    await router.drainOnce();

    expect(calls).toEqual([{ id: task.id, resume: true }]);
    const done = store.get(task.id)!;
    expect(done.status).toBe("succeeded");
    expect(sh(["git", "-C", repo, "cat-file", "-e", `${branch}:out.txt`]).code).toBe(0);
    expect(existsSync(workdir)).toBe(false);
  });

  test("resume 拒绝未中断、非本人、无工作副本的请求", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 待办"));
    const task = store.recent()[0]!;

    // 还在排队，不是中断状态
    await router.handle(msg(`/pisa resume ${task.id}`));
    expect(channel.sent.at(-1)?.text).toContain("只有中断");
    expect(store.get(task.id)?.status).toBe("queued");

    // 置为 paused 但没有工作副本
    expect(store.claimQueued(task.id, Date.now(), `pisa/${task.id}`)).toBe(true);
    expect(store.transition(task.id, "paused")).toBe(true);

    await router.handle(msg(`/pisa resume ${task.id}`, { userId: "u2" }));
    expect(channel.sent.at(-1)?.text).toContain("原请求者");

    await router.handle(msg(`/pisa resume ${task.id}`));
    expect(channel.sent.at(-1)?.text).toContain("工作副本");
    expect(store.get(task.id)?.status).toBe("paused");

    // 私聊 /resume 走同一条恢复路径
    await router.handle(msg(`/resume ${task.id}`, { isDirect: true }));
    expect(channel.sent.at(-1)?.text).toContain("工作副本");
  });

  test("paused 的任务可以取消", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 待办"));
    const task = store.recent()[0]!;
    expect(store.claimQueued(task.id, Date.now(), `pisa/${task.id}`)).toBe(true);
    expect(store.transition(task.id, "paused")).toBe(true);

    await router.handle(msg(`/pisa cancel ${task.id}`));
    expect(store.get(task.id)?.status).toBe("cancelled");
  });
});

describe("状态机", () => {
  const baseTask: Task = {
    id: "t0",
    source: "s",
    channel: "c",
    chatId: "c",
    requester: "u",
    repo: "demo",
    prompt: "p",
    status: "queued",
    branch: null,
    prUrl: null,
    sessionId: null,
    baseRef: null,
    context: null,
    summary: null,
    error: null,
    createdAt: 0,
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
  };
  const task = (over: Partial<Task> & { id: string }): Task => ({ ...baseTask, ...over });

  test("非法跃迁被拒绝", () => {
    const store = new Store(":memory:");
    store.insertTask(task({ id: "t1" }));
    expect(store.transition("t1", "succeeded")).toBe(false);
    expect(store.transition("t1", "running")).toBe(true);
    expect(store.transition("t1", "running")).toBe(false);
    store.close();
  });

  test("running 可暂停再恢复，queued 不能直接暂停", () => {
    const store = new Store(":memory:");
    store.insertTask(task({ id: "t_run", status: "running" }));
    expect(store.transition("t_run", "paused")).toBe(true);
    expect(store.transition("t_run", "paused")).toBe(false);
    expect(store.transition("t_run", "running")).toBe(true);

    store.insertTask(task({ id: "t_queued" }));
    expect(store.transition("t_queued", "paused")).toBe(false);
    store.close();
  });

  test("暂停的任务可以放弃", () => {
    const store = new Store(":memory:");
    store.insertTask(task({ id: "t_pause", status: "running" }));
    expect(store.transition("t_pause", "paused")).toBe(true);
    expect(store.transition("t_pause", "cancelled")).toBe(true);
    expect(store.get("t_pause")?.status).toBe("cancelled");
    store.close();
  });
});
