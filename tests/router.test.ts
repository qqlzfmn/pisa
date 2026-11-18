import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router, formatDuration } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { parseCommand, taskGuard, type Config } from "../src/config";
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

  test("确认命令", () => {
    expect(parseCommand("/pisa confirm", "/pisa")).toEqual({ kind: "confirm", body: "" });
  });
});

describe("taskGuard", () => {
  test("命令错拼给出建议", () => {
    expect(taskGuard("stats")).toEqual({ kind: "suggest", command: "status" });
    expect(taskGuard("cancell")).toEqual({ kind: "suggest", command: "cancel" });
  });

  test("其余单英文词要求确认", () => {
    expect(taskGuard("refactor")).toEqual({ kind: "confirm" });
  });

  test("中文与多词正文放行", () => {
    expect(taskGuard("修复")).toBeNull();
    expect(taskGuard("fix login bug")).toBeNull();
  });
});

describe("formatDuration", () => {
  test("不足 1 分钟显示秒", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  test("不足 1 小时显示 XmYs", () => {
    expect(formatDuration(60_000)).toBe("1m0s");
    expect(formatDuration(192_000)).toBe("3m12s");
    expect(formatDuration(3_599_999)).toBe("59m59s");
  });

  test("1 小时以上显示 XhYm", () => {
    expect(formatDuration(3_600_000)).toBe("1h0m");
    expect(formatDuration(7_500_000)).toBe("2h5m");
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

  function build(worker: WorkerRunner, now?: () => number) {
    return new Router({ cfg, store, worker, deliverer: new GitDeliverer(cfg), channel, now });
  }

  /** 直接落一条任务，用于构造续跑/占用场景 */
  function seedTask(over: Partial<Task> & { id: string }): Task {
    const { id, ...rest } = over;
    const task: Task = {
      id,
      source: `seed:${id}`,
      channel: "fake",
      chatId: "c1",
      requester: "u1",
      repo: "demo",
      prompt: "续跑",
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
      cancelRequested: false,
      ...rest,
    };
    store.insertTask(task);
    return task;
  }

  describe("能力索引", () => {
    test("/pisa examples 输出场景且不建任务", async () => {
      const router = build(okWorker);
      await router.handle(msg("/pisa examples"));

      expect(store.recentTasks()).toHaveLength(0);
      const text = channel.sent.at(-1)!.text;
      const blocks = text.match(/^   触发：/gm) ?? [];
      expect(blocks.length).toBeGreaterThanOrEqual(6);
      expect(blocks.length).toBeLessThanOrEqual(8);
      expect(text).toContain("docs/usage.md");
    });

    test("私聊 /examples 免触发词", async () => {
      const router = build(okWorker);
      await router.handle(msg("/examples", { isDirect: true }));

      expect(store.recentTasks()).toHaveLength(0);
      expect(channel.sent.at(-1)?.text).toContain("触发：");
    });

    test("/pisa help 按派活/查询/维护/集成分组", async () => {
      const router = build(okWorker);
      await router.handle(msg("/pisa help"));

      const text = channel.sent.at(-1)!.text;
      const headers = text.split("\n").filter((l) => ["派活", "查询", "维护", "集成"].includes(l));
      expect(headers).toEqual(["派活", "查询", "维护", "集成"]);
      expect(text).toContain("/pisa examples");
      expect(text).toContain("/pisa confirm");
    });
  });

  describe("多仓库路由", () => {
    let family: string;

    beforeEach(() => {
      family = makeRepo();
      cfg = {
        ...cfg,
        whitelist: { users: ["u1"], repos: ["demo", "family"] },
        repos: [cfg.repos[0]!, { alias: "family", path: family, baseBranch: "main" }],
      };
    });

    afterEach(() => {
      rmSync(family, { recursive: true, force: true });
    });

    test("触发词后指定仓库，正文去掉别名", async () => {
      const router = build(okWorker);
      await router.handle(msg("/pisa @family 做X"));

      const task = store.recentTasks()[0]!;
      expect(task.repo).toBe("family");
      expect(task.prompt).toBe("做X");
      expect(channel.sent.some((s) => s.text.includes("仓库：family"))).toBe(true);
    });

    test("私聊裸文本指定仓库", async () => {
      const router = build(okWorker);
      await router.handle(msg("@family 做X", { isDirect: true }));

      const task = store.recentTasks()[0]!;
      expect(task.repo).toBe("family");
      expect(task.prompt).toBe("做X");
    });

    test("未知别名保持原文并走默认仓库（触发词形式）", async () => {
      const router = build(okWorker);
      await router.handle(msg("/pisa @nope 做X"));

      const task = store.recentTasks()[0]!;
      expect(task.repo).toBe("demo");
      expect(task.prompt).toBe("@nope 做X");
    });

    test("未知别名保持原文并走默认仓库（私聊裸文本）", async () => {
      const router = build(okWorker);
      await router.handle(msg("@nope 做X", { isDirect: true }));

      const task = store.recentTasks()[0]!;
      expect(task.repo).toBe("demo");
      expect(task.prompt).toBe("@nope 做X");
    });

    test("帮助文本包含别名语法", async () => {
      const router = build(okWorker);
      await router.handle(msg("/pisa help"));
      expect(channel.sent.at(-1)?.text).toContain("@别名");
    });

    test("续跑留在父任务所在仓库，不被别名带走", async () => {
      const parent = seedTask({ id: "t_family_parent", repo: "family", branch: "pisa/parent", status: "succeeded" });
      expect(sh(["git", "-C", family, "branch", parent.branch!, "main"]).code).toBe(0);

      const router = build(okWorker);
      await router.handle(msg(`/pisa @demo continue ${parent.id} 再改一处`));

      const task = store.recentTasks()[0]!;
      expect(task.repo).toBe("family");
      expect(task.baseRef).toBe("pisa/parent");
      expect(task.prompt).toBe("再改一处");
    });
  });

  test("私聊不带触发词也能建任务", async () => {
    const router = build(okWorker);
    await router.handle(msg("把登录超时改成 30 分钟", { isDirect: true }));
    expect(store.recentTasks()[0]?.prompt).toBe("把登录超时改成 30 分钟");
  });

  test("群聊仍然需要触发词", async () => {
    const router = build(okWorker);
    await router.handle(msg("把登录超时改成 30 分钟", { isDirect: false }));
    expect(store.recentTasks().length).toBe(0);
  });

  test("私聊 /status 不走任务", async () => {
    const router = build(okWorker);
    await router.handle(msg("/status", { isDirect: true }));
    expect(store.recentTasks().length).toBe(0);
    const text = channel.sent.at(-1)!.text;
    expect(text).toContain("运行中\n(无)");
    expect(text).toContain("汇总：0 个任务 · 成功 0 · 失败 0 · 暂停 0");
    expect(text).toContain("最近 24h：无完成");
  });

  test("非白名单用户被拒，且不建任务", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 做点事", { userId: "stranger" }));
    expect(store.recentTasks().length).toBe(0);
    expect(channel.sent[0]?.text).toContain("无权限");
  });

  test("同一事件重复投递只建一个任务", async () => {
    const router = build(okWorker);
    const m = msg("/pisa 做点事");
    await router.handle(m);
    await router.handle(m);
    expect(store.recentTasks().length).toBe(1);
  });

  test("完整链路：接单 → 执行 → 提交到分支，主分支不变", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 新建 out.txt"));
    expect(store.recentTasks()[0]?.status).toBe("queued");

    const ran = await router.drainOnce();
    expect(ran).toBe(true);

    const task = store.recentTasks()[0]!;
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

  test("续跑任务失败不删除共享分支", async () => {
    const failWorker: WorkerRunner = {
      async run(): Promise<WorkerResult> {
        return { ok: false, summary: "", error: "改坏了", exitCode: 1 };
      },
    };
    const router = build(failWorker);
    const shared = "pisa/parent";
    expect(sh(["git", "-C", repo, "branch", shared, "main"]).code).toBe(0);
    const task = seedTask({ id: "t_child_fail", branch: shared, baseRef: shared, prUrl: "https://github.com/o/r/pull/12" });

    await router.drainOnce();

    expect(store.get(task.id)?.status).toBe("failed");
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", shared]).code).toBe(0);
    // 任务自建的分支才应该被清理
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", `pisa/${task.id}`]).code).not.toBe(0);
  });

  test("续跑任务取消不删除共享分支", async () => {
    const cancelWorker: WorkerRunner = {
      async run(): Promise<WorkerResult> {
        return { ok: false, summary: "", error: "任务已取消", exitCode: 130 };
      },
    };
    const router = build(cancelWorker);
    const shared = "pisa/parent";
    expect(sh(["git", "-C", repo, "branch", shared, "main"]).code).toBe(0);
    const task = seedTask({ id: "t_child_cancel", branch: shared, baseRef: shared });
    store.requestCancel(task.id);

    await router.drainOnce();

    expect(store.get(task.id)?.status).toBe("cancelled");
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", shared]).code).toBe(0);
  });

  test("分支被其它工作副本占用时任务失败并报错，不新建同名分支", async () => {
    const router = build(okWorker);
    const shared = "pisa/busy";
    expect(createWorktree(repo, join(stateDir, "busy-wt"), shared).code).toBe(0);
    const task = seedTask({ id: "t_busy", branch: shared, baseRef: shared });

    await router.drainOnce();

    const done = store.get(task.id)!;
    expect(done.status).toBe("failed");
    expect(done.error).toContain("已被其它工作副本占用");
    expect(done.error).toContain(shared);
    // 没有为目标任务建出工作副本，也没有派生新分支
    expect(existsSync(join(stateDir, "worktrees", task.id))).toBe(false);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", `pisa/${task.id}`]).code).not.toBe(0);
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

    const task = store.recentTasks()[0]!;
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
    expect(Math.abs(starts[0]! - starts[1]!)).toBeLessThan(500);
    expect(total).toBeLessThan(2000);
    expect(store.recentTasks().every((t) => t.status === "succeeded")).toBe(true);
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
    const parent = store.recentTasks()[0]!;
    store.transition(parent.id, "running", { branch: "pisa/parent", startedAt: Date.now() });
    store.transition(parent.id, "succeeded", { summary: "建了 a.txt", endedAt: Date.now() });

    await router.handle(msg(`/pisa continue ${parent.id} 再改一处`));
    const child = store.recentTasks()[0]!;
    expect(child.baseRef).toBe("pisa/parent");
    expect(child.context).toContain(parent.id);
    expect(child.prompt).toBe("再改一处");
  });

  test("continue 找不到任务时拒绝", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa continue t_missing 再改"));
    expect(store.recentTasks().length).toBe(0);
    expect(channel.sent[0]?.text).toContain("找不到任务");
  });

  test("merge 把任务分支合入主干", async () => {
    // 看护模式下合并成功会自行退出进程；跑测试时不能带上，否则杀掉测试进程
    const supervised = process.env.PISA_SUPERVISED;
    delete process.env.PISA_SUPERVISED;
    try {
      const router = build(okWorker);
      await router.handle(msg("/pisa 新建 out.txt"));
      await router.drainOnce();
      const id = store.recentTasks()[0]!.id;

      await router.handle(msg(`/pisa merge ${id}`));
      expect(channel.sent.some((s) => s.text.includes("已合并"))).toBe(true);
      expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).toBe(0);
    } finally {
      if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
    }
  });

  test("main 前进后 merge 仍能快进（先 rebase）", async () => {
    const supervised = process.env.PISA_SUPERVISED;
    delete process.env.PISA_SUPERVISED;
    try {
      const router = build(okWorker);
      await router.handle(msg("/pisa 新建 out.txt"));
      await router.drainOnce();
      const id = store.recentTasks()[0]!.id;

      writeFileSync(join(repo, "later.txt"), "later\n");
      sh(["git", "-C", repo, "add", "-A"]);
      sh(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "later"]);

      await router.handle(msg(`/pisa merge ${id}`));
      expect(channel.sent.some((s) => s.text.includes("已合并"))).toBe(true);
      expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).toBe(0);
      expect(sh(["git", "-C", repo, "cat-file", "-e", "main:later.txt"]).code).toBe(0);
    } finally {
      if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
    }
  });

  test("回复任务消息自动续跑该任务", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 第一轮"));
    await router.drainOnce();
    const parent = store.recentTasks()[0]!;
    store.linkMessage("c1", "9001", parent.id);

    await router.handle(msg("再加一行", { replyToMessageId: 9001 }));
    const child = store.recentTasks()[0]!;
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
    const t = store.recentTasks()[0]!;
    expect(t.status).toBe("succeeded");
    expect(sh(["git", "--git-dir", bare, "rev-parse", "--verify", t.branch!]).code).toBe(0);

    sh(["git", "-C", repo, "remote", "remove", "origin"]);
    rmSync(bare, { recursive: true, force: true });
  });

  test("status 看板：运行中 + PR 链接 + 汇总", async () => {
    const now = 1_700_000_000_000;
    const longPrompt = "把登录超时从 5 分钟改成 30 分钟并补一条回归测试覆盖超时分支，同时确认失败重试与日志输出都符合预期";
    seedTask({ id: "t_running", prompt: longPrompt, createdAt: now - 200_000 });
    expect(store.claimQueued("t_running", now - 192_000, "pisa/t_running")).toBe(true);
    seedTask({ id: "t_queued", prompt: "排队中的事", createdAt: now - 100_000 });
    seedTask({ id: "t_done", repo: "demo", prompt: "加一条校验", createdAt: now - 600_000 });
    expect(store.claimQueued("t_done", now - 590_000, "pisa/t_done")).toBe(true);
    expect(
      store.transition("t_done", "succeeded", { endedAt: now - 350_000, prUrl: "https://github.com/o/r/pull/12" }),
    ).toBe(true);

    const router = build(okWorker, () => now);
    await router.handle(msg("/pisa status"));

    const text = channel.sent.at(-1)!.text;
    expect(text).toContain("t_running · working（执行中） · demo · 已运行 3m12s");
    expect(text).toContain(longPrompt.slice(0, 40));
    expect(text).not.toContain(longPrompt);
    expect(text).toContain("排队（1）");
    expect(text).toContain("t_queued · working/queued（等空闲槽位） · demo · 排队中的事");
    expect(text).toContain("成功 · person/review（等你评审） · 4m0s · demo · 加一条校验 · https://github.com/o/r/pull/12");
    expect(text).toContain("汇总：3 个任务 · 成功 1 · 失败 0 · 暂停 0");
    expect(text).toContain("最近 24h：完成 1 · 成功 1 · 失败 0 · 成功率 100% · P50 4m0s · P95 4m0s");
  });

  test("recentTasks 限制数量并按创建时间倒序", () => {
    seedTask({ id: "t_a", createdAt: 100 });
    seedTask({ id: "t_b", createdAt: 200 });
    seedTask({ id: "t_c", createdAt: 300 });
    expect(store.recentTasks(2).map((t) => t.id)).toEqual(["t_c", "t_b"]);
  });

  test("排队中的任务可以取消", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 待办"));
    const id = store.recentTasks()[0]!.id;
    await router.handle(msg(`/pisa cancel ${id}`));

    expect(store.get(id)?.status).toBe("cancelled");
    expect(await router.drainOnce()).toBe(false);
  });

  test("启动恢复：可恢复的转 paused，其余 failed，工作副本保留", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 任务 A"));
    await router.handle(msg("/pisa 任务 B"));
    const a = store.recentTasks().find((t) => t.prompt === "任务 A")!;
    const b = store.recentTasks().find((t) => t.prompt === "任务 B")!;

    const workdirA = join(stateDir, "worktrees", a.id);
    expect(store.claimQueued(a.id, Date.now(), `pisa/${a.id}`)).toBe(true);
    expect(createWorktree(repo, workdirA, `pisa/${a.id}`).code).toBe(0);
    store.setSessionId(a.id, "sess-a");

    expect(store.claimQueued(b.id, Date.now(), `pisa/${b.id}`)).toBe(true);

    expect(router.recoverInterrupted()).toEqual({ paused: 1, failed: 1, cancelled: 0 });
    expect(store.get(a.id)?.status).toBe("paused");
    expect(store.get(b.id)?.status).toBe("failed");
    expect(store.get(b.id)?.error).toContain("中断");
    expect(existsSync(workdirA)).toBe(true);
  });

  test("启动恢复：已请求取消的任务转 cancelled，不能被 resume 复活", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 要取消的任务"));
    await router.handle(msg("/pisa 对照任务"));
    const vetoed = store.recentTasks().find((t) => t.prompt === "要取消的任务")!;
    const control = store.recentTasks().find((t) => t.prompt === "对照任务")!;

    for (const t of [vetoed, control]) {
      const workdir = join(stateDir, "worktrees", t.id);
      expect(store.claimQueued(t.id, Date.now(), `pisa/${t.id}`)).toBe(true);
      expect(createWorktree(repo, workdir, `pisa/${t.id}`).code).toBe(0);
      store.setSessionId(t.id, `sess-${t.id}`);
    }
    // 执行中说 cancel：只置位，不落地；随后进程重启
    expect(store.requestCancel(vetoed.id)).toBe(true);

    expect(router.recoverInterrupted()).toEqual({ paused: 1, failed: 0, cancelled: 1 });
    expect(store.get(vetoed.id)?.status).toBe("cancelled");
    expect(store.get(control.id)?.status).toBe("paused");
    expect(existsSync(join(stateDir, "worktrees", vetoed.id))).toBe(true);

    await router.handle(msg(`/pisa resume ${vetoed.id}`));
    expect(channel.sent.at(-1)?.text).toContain("不是中断状态");
    expect(store.get(vetoed.id)?.status).toBe("cancelled");
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
    const task = store.recentTasks()[0]!;
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

  test(
    "resume 从进度文件末尾继续，不重放上一轮的工具调用",
    async () => {
      cfg.notifications = { progress: true };
      const gate = Promise.withResolvers<void>();
      const holding: WorkerRunner = {
        async run(_task, workdir) {
          await gate.promise;
          writeFileSync(join(workdir, "out.txt"), "hi\n");
          return { ok: true, summary: "继续完成", exitCode: 0 };
        },
      };
      const router = build(holding);
      await router.handle(msg("/pisa 恢复中的任务"));
      const task = store.recentTasks()[0]!;
      const branch = `pisa/${task.id}`;
      const workdir = join(stateDir, "worktrees", task.id);
      expect(store.claimQueued(task.id, Date.now(), branch)).toBe(true);
      expect(createWorktree(repo, workdir, branch).code).toBe(0);
      store.setSessionId(task.id, "sess-1");
      expect(store.transition(task.id, "paused")).toBe(true);

      // 上一轮已经推送过的三条进度
      mkdirSync(join(stateDir, "progress"), { recursive: true });
      const progress = join(stateDir, "progress", `${task.id}.jsonl`);
      writeFileSync(
        progress,
        [
          '{"type":"tool","tool":"bash","detail":"old-bash-1"}',
          '{"type":"tool","tool":"edit","detail":"old-edit-2"}',
          '{"type":"tool","tool":"bash","detail":"old-bash-3"}',
          "",
        ].join("\n"),
      );

      await router.handle(msg(`/pisa resume ${task.id}`));
      await Bun.sleep(4200); // 两个 tick
      expect(channel.sent.some((s) => /old-bash-1|old-edit-2|old-bash-3/.test(s.text))).toBe(false);

      // 新一轮追加一行：6 秒内只应多出这一条
      writeFileSync(
        progress,
        (await Bun.file(progress).text()) + '{"type":"tool","tool":"bash","detail":"new-line-4"}\n',
      );
      await Bun.sleep(6000);
      expect(channel.sent.filter((s) => s.text.includes("new-line-4")).length).toBe(1);

      gate.resolve();
      await router.drainOnce();
      expect(store.get(task.id)?.status).toBe("succeeded");
    },
    20_000,
  );

  test("resume 拒绝未中断、非本人、无工作副本的请求", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 待办"));
    const task = store.recentTasks()[0]!;

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
    const task = store.recentTasks()[0]!;
    expect(store.claimQueued(task.id, Date.now(), `pisa/${task.id}`)).toBe(true);
    expect(store.transition(task.id, "paused")).toBe(true);

    await router.handle(msg(`/pisa cancel ${task.id}`));
    expect(store.get(task.id)?.status).toBe("cancelled");
  });

  test("关停中 Worker 完成后任务保持 running，工作副本与分支保留", async () => {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const worker: WorkerRunner = {
      async run(_task, workdir): Promise<WorkerResult> {
        writeFileSync(join(workdir, "out.txt"), "hi\n");
        started.resolve();
        await gate.promise;
        return { ok: true, summary: "改了 out.txt", exitCode: 0 };
      },
    };
    const router = build(worker);
    await router.handle(msg("/pisa 关停测试"));
    const task = store.recentTasks()[0]!;

    const drain = router.drainOnce();
    await started.promise;
    const stopping = router.stop();
    gate.resolve();
    await stopping;
    await drain;

    const after = store.get(task.id)!;
    expect(after.status).toBe("running");
    expect(existsSync(join(stateDir, "worktrees", task.id))).toBe(true);
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", `pisa/${task.id}`]).code).toBe(0);
    expect(channel.sent.some((s) => s.text.includes("完成") || s.text.includes("失败"))).toBe(false);
  });

  test("stop() 之后不再调度新任务", async () => {
    const router = build(okWorker);
    await router.handle(msg("/pisa 排队任务"));
    const task = store.recentTasks()[0]!;

    await router.stop();
    expect(await router.drainOnce()).toBe(false);
    expect(store.get(task.id)?.status).toBe("queued");
    expect(existsSync(join(stateDir, "worktrees", task.id))).toBe(false);
  });

  describe("命令误触防护", () => {
    test("命令错拼不建任务，回复建议命令", async () => {
      const router = build(okWorker);
      await router.handle(msg("/pisa stats"));

      expect(store.recentTasks()).toHaveLength(0);
      expect(channel.sent.at(-1)?.text).toContain("/pisa status");
    });

    test("单英文词先要求确认，确认后建任务", async () => {
      const router = build(okWorker);
      await router.handle(msg("/pisa refactor"));
      expect(store.recentTasks()).toHaveLength(0);
      expect(channel.sent.at(-1)?.text).toContain("确认");

      await router.handle(msg("/pisa confirm"));
      const task = store.recentTasks()[0]!;
      expect(task.prompt).toBe("refactor");
    });

    test("待确认 10 分钟后失效", async () => {
      let now = 1_000_000;
      const router = build(okWorker, () => now);
      await router.handle(msg("/pisa refactor"));
      now += 10 * 60 * 1000 + 1;

      await router.handle(msg("/pisa confirm"));
      expect(store.recentTasks()).toHaveLength(0);
      expect(channel.sent.at(-1)?.text).toContain("没有待确认");
    });

    test("没有待确认时 confirm 不建任务", async () => {
      const router = build(okWorker);
      await router.handle(msg("/pisa confirm"));

      expect(store.recentTasks()).toHaveLength(0);
      expect(channel.sent.at(-1)?.text).toContain("没有待确认");
    });

    test("等待确认时发别的命令视为放弃", async () => {
      const router = build(okWorker);
      await router.handle(msg("/pisa refactor"));
      await router.handle(msg("/pisa 待办"));
      await router.handle(msg("/pisa confirm"));

      expect(store.recentTasks().map((t) => t.prompt)).toEqual(["待办"]);
    });

    test("中文正文直通建任务", async () => {
      const router = build(okWorker);
      await router.handle(msg("/pisa 修复"));

      expect(store.recentTasks()[0]?.prompt).toBe("修复");
    });

    test("私聊错拼斜杠命令给建议，不建任务", async () => {
      const router = build(okWorker);
      await router.handle(msg("/stats", { isDirect: true }));

      expect(store.recentTasks()).toHaveLength(0);
      expect(channel.sent.at(-1)?.text).toContain("/status");
    });
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
    replyPr: null,
    replyIssue: null,
    replyRepo: null,
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

describe("执行器丢失与合并门禁", () => {
  const base = (id: string): Task => ({
    id,
    source: `seed:${id}`,
    channel: "fake",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "x",
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
    cancelRequested: false,
  });

  function mk() {
    const repo = makeRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pisa-state-"));
    const cfg = makeCfg(repo, stateDir);
    const store = new Store(":memory:");
    const channel = new FakeChannel();
    const router = new Router({ cfg, store, worker: okWorker, deliverer: new GitDeliverer(cfg), channel });
    return { store, channel, router, stateDir, repo };
  }

  test("running 但没有执行器 → failed", () => {
    const { store, router } = mk();
    store.insertTask(base("t_orphan"));
    expect(store.claimQueued("t_orphan", Date.now() - 60_000, "pisa/t_orphan")).toBe(true);
    expect(router.reconcileOrphans()).toBe(1);
    expect(store.get("t_orphan")!.status).toBe("failed");
    store.close();
  });

  test("有 worktree 与会话 → paused", () => {
    const { store, router, stateDir } = mk();
    mkdirSync(join(stateDir, "worktrees", "t_resume"), { recursive: true });
    store.insertTask({ ...base("t_resume") });
    expect(store.claimQueued("t_resume", Date.now() - 60_000, "pisa/t_resume")).toBe(true);
    store.setSessionId("t_resume", "s1");
    expect(router.reconcileOrphans()).toBe(1);
    expect(store.get("t_resume")!.status).toBe("paused");
    store.close();
  });

  test("gc 清理已结束任务的分支", async () => {
    const { store, router, channel, repo } = mk();
    sh(["git", "-C", repo, "branch", "pisa/t_gc", "main"]);
    store.insertTask({ ...base("t_gc"), status: "queued", branch: "pisa/t_gc" });
    store.claimQueued("t_gc", Date.now() - 60_000, "pisa/t_gc");
    store.transition("t_gc", "failed", { endedAt: 1, error: "x" });
    await router.handle(msg("/pisa gc 0"));
    expect(sh(["git", "-C", repo, "rev-parse", "--verify", "pisa/t_gc"]).code).not.toBe(0);
    expect(channel.sent.at(-1)!.text).toContain("已清理");
  });

  test("过程消息默认关闭，可开关", async () => {
    const { router, channel } = mk();
    await router.handle(msg("/pisa verbose"));
    expect(channel.sent.at(-1)!.text).toContain("过程消息：关");
    await router.handle(msg("/pisa verbose on"));
    expect(channel.sent.at(-1)!.text).toContain("过程消息：开");
  });

  test("有任务在跑时拒绝合并", async () => {
    const { store, router, channel } = mk();
    store.insertTask({ ...base("t_done"), status: "succeeded", branch: "pisa/t_done", startedAt: 1, endedAt: 2 });
    (router as unknown as { active: Map<string, Promise<void>> }).active.set("busy", Promise.resolve());
    await router.handle(msg("/pisa merge t_done"));
    expect(channel.sent.at(-1)!.text).toContain("还有 1 个任务在执行");
    store.close();
  });
});
