import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer, type Deliverer } from "../src/deliver";
import type { Config } from "../src/config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import type { ExecResult } from "../src/git";
import { sh } from "../src/git";
import type { Runner } from "../src/github";
import { autoMerge, ciVerdict, parseVerdict, type AutoMergeResult, type PrSnapshot } from "../src/auto-merge";

const PR_URL = "https://github.com/o/r/pull/7";
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t_1",
    source: "github",
    channel: "fake",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "修 bug",
    status: "succeeded",
    branch: "pisa/t_1",
    prUrl: PR_URL,
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
    ...over,
  };
}

/** 断言 blocked 并收窄类型，避免每个用例重复判断 */
function blocked(res: AutoMergeResult): Extract<AutoMergeResult, { status: "blocked" }> {
  if (res.status !== "blocked") throw new Error(`期望 blocked，实际 ${res.status}`);
  return res;
}

function ok(out = ""): ExecResult {
  return { code: 0, out, err: "" };
}

function snapshot(state: string, headSha: string, checks: PrSnapshot["checks"]): string {
  return JSON.stringify({ state, headRefOid: headSha, statusCheckRollup: checks });
}

const GREEN = [{ name: "ci", state: "SUCCESS" }];

/** pr view 的两次查询字段不同：检查用 statusCheckRollup，合并后用 mergeCommit */
function isChecksQuery(args: string[]): boolean {
  return args.includes("state,headRefOid,statusCheckRollup");
}

describe("ciVerdict", () => {
  test("空检查不算绿", () => {
    expect(ciVerdict([]).state).toBe("none");
  });

  test("全部成功才算绿", () => {
    expect(ciVerdict([{ name: "ci", state: "SUCCESS" }]).state).toBe("green");
    expect(ciVerdict([{ name: "ci", state: "IN_PROGRESS" }]).state).toBe("pending");
    expect(ciVerdict([{ name: "ci", state: "FAILURE" }])).toEqual({ state: "failed", failing: ["ci"] });
  });
});

describe("parseVerdict", () => {
  test("容忍围栏和解释文字，取最后一个 verdict", () => {
    const text = '说明如下：\n```json\n{"verdict":"pass","blockers":[],"summary":"ok"}\n```\n';
    expect(parseVerdict(text)?.verdict).toBe("pass");
  });

  test("字符串里的括号不破坏解析", () => {
    const text = '{"verdict":"fail","blockers":["a {b} c"],"summary":"括号"}';
    expect(parseVerdict(text)?.blockers).toEqual(["a {b} c"]);
  });

  test("没有 verdict 返回 null", () => {
    expect(parseVerdict("评审完成，没有问题")).toBeNull();
  });
});

describe("autoMerge", () => {
  test("CI 未绿时不评审也不合并", async () => {
    const calls: string[][] = [];
    let reviewed = false;
    const runner: Runner = (args) => {
      calls.push(args);
      if (isChecksQuery(args)) {
        return ok(snapshot("OPEN", HEAD, [{ name: "ci", state: "IN_PROGRESS" }]));
      }
      return ok();
    };
    const res = await autoMerge(task(), {
      runner,
      review: async () => {
        reviewed = true;
        return '{"verdict":"pass","blockers":[],"summary":"ok"}';
      },
      ciTimeoutMs: 50,
      ciPollMs: 10,
      sleep: async () => {},
    });

    expect(blocked(res).reason).toContain("超时");
    expect(reviewed).toBe(false);
    expect(calls.some((a) => a[2] === "merge")).toBe(false);
  });

  test("CI 失败立即阻塞，不等超时", async () => {
    const runner: Runner = (args) =>
      isChecksQuery(args) ? ok(snapshot("OPEN", HEAD, [{ name: "ci", state: "FAILURE" }])) : ok();
    const res = await autoMerge(task(), { runner, review: async () => "{}", ciTimeoutMs: 50, ciPollMs: 10 });
    expect(blocked(res).reason).toContain("CI 未通过");
  });

  test("评审 fail 时评论阻塞项且不合并", async () => {
    const calls: string[][] = [];
    const runner: Runner = (args) => {
      calls.push(args);
      if (isChecksQuery(args)) return ok(snapshot("OPEN", HEAD, GREEN));
      if (args[2] === "diff") return ok("diff --git a/x b/x\n+1\n");
      return ok();
    };
    const res = await autoMerge(task(), {
      runner,
      review: async () => '{"verdict":"fail","blockers":["src/x.ts:1 没有处理空值"],"summary":"有阻塞项"}',
    });

    const out = blocked(res);
    expect(out.blockers).toEqual(["src/x.ts:1 没有处理空值"]);
    const comment = calls.find((a) => a[2] === "comment");
    expect(comment).toBeDefined();
    expect(comment!.join("\n")).toContain("src/x.ts:1 没有处理空值");
    expect(comment!.join("\n")).toContain(`<!-- pisa:review task=t_1 sha=${HEAD} -->`);
    expect(calls.some((a) => a[2] === "merge")).toBe(false);
  });

  test("评审后 head 变化则不合并", async () => {
    const calls: string[][] = [];
    let views = 0;
    const runner: Runner = (args) => {
      calls.push(args);
      if (isChecksQuery(args)) {
        views += 1;
        return ok(snapshot("OPEN", views === 1 ? HEAD : NEXT, GREEN));
      }
      if (args[2] === "diff") return ok("diff --git a/x b/x\n+1\n");
      return ok();
    };
    const res = await autoMerge(task(), {
      runner,
      review: async () => '{"verdict":"pass","blockers":[],"summary":"ok"}',
    });

    expect(blocked(res).reason).toContain("head 已变化");
    expect(calls.some((a) => a[2] === "merge")).toBe(false);
  });

  test("全绿 + pass + head 未变才 squash 合并并删分支", async () => {
    const calls: string[][] = [];
    const runner: Runner = (args) => {
      calls.push(args);
      if (isChecksQuery(args)) return ok(snapshot("OPEN", HEAD, GREEN));
      if (args[2] === "diff") return ok("diff --git a/x b/x\n+1\n");
      if (args[2] === "view") return ok(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "c".repeat(40) } }));
      return ok();
    };
    const res = await autoMerge(task(), {
      runner,
      review: async () => '```json\n{"verdict":"pass","blockers":[],"summary":"没问题"}\n```',
    });

    expect(res.status).toBe("merged");
    if (res.status !== "merged") return;
    expect(res.mergeCommit).toBe("c".repeat(40));
    const merge = calls.find((a) => a[2] === "merge");
    expect(merge).toBeDefined();
    expect(merge!.join(" ")).toContain("--squash");
    expect(merge!.join(" ")).toContain("--delete-branch");
  });
});

// ---- Router 接线：开关关闭时保持本地合并 ----

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: string[] = [];
  async start(): Promise<void> {}
  async send(_chatId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push(text);
    return { messageId: String(this.sent.length) };
  }
  async stop(): Promise<void> {}
}

function msg(text: string): IncomingMessage {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    channel: "fake",
    chatId: "c1",
    userId: "u1",
    text,
  };
}

const okWorker: WorkerRunner = {
  async run(_task, workdir): Promise<WorkerResult> {
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    return { ok: true, summary: "改了 out.txt", exitCode: 0 };
  },
};

describe("Router autoMerge 开关", () => {
  let root: string;
  let repo: string;
  let store: Store;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pisa-automerge-"));
    repo = join(root, "repo");
    sh(["git", "init", "-q", "-b", "main", repo]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    sh(["git", "-C", repo, "add", "-A"]);
    sh(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    store = new Store(join(root, "state.db"));
  });

  afterEach(() => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function build(
    autoMergeOn: boolean,
    ghCalls: string[][],
    reviewed: () => void,
    extra: { deliverer?: Deliverer; channel?: ChannelAdapter; ghRunner?: Runner } = {},
  ): Router {
    const cfg: Config = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: ["u1"], repos: ["demo"] },
      repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      github: { enabled: false, autoMerge: autoMergeOn },
      stateDir: join(root, "state"),
    };
    const reviewer: WorkerRunner = {
      async run(): Promise<WorkerResult> {
        reviewed();
        return { ok: true, summary: '{"verdict":"pass","blockers":[],"summary":"ok"}', exitCode: 0 };
      },
    };
    return new Router({
      cfg,
      store,
      worker: okWorker,
      reviewer,
      deliverer: extra.deliverer ?? new GitDeliverer(cfg),
      channel: extra.channel ?? new FakeChannel(),
      ghRunner:
        extra.ghRunner ??
        ((args) => {
          ghCalls.push(args);
          return ok();
        }),
    });
  }

  test("关闭时 /pisa merge 仍走本地合并，不评审、不调 gh", async () => {
    const supervised = process.env.PISA_SUPERVISED;
    delete process.env.PISA_SUPERVISED;
    try {
      const ghCalls: string[][] = [];
      let reviewCalls = 0;
      const router = build(false, ghCalls, () => {
        reviewCalls += 1;
      });
      await router.handle(msg("/pisa 新建 out.txt"));
      await router.drainOnce();
      const id = store.recentTasks()[0]!.id;

      await router.handle(msg(`/pisa merge ${id}`));

      expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).toBe(0);
      expect(store.effectsOf(id).some((e) => e.kind === "merge")).toBe(true);
      expect(reviewCalls).toBe(0);
      expect(ghCalls.length).toBe(0);
    } finally {
      if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
    }
  });

  test("开启但任务没有 PR 时拒绝进入 PR 流程", async () => {
    const supervised = process.env.PISA_SUPERVISED;
    delete process.env.PISA_SUPERVISED;
    try {
      const ghCalls: string[][] = [];
      const router = build(true, ghCalls, () => {});
      await router.handle(msg("/pisa 新建 out.txt"));
      await router.drainOnce();
      const id = store.recentTasks()[0]!.id;

      await router.handle(msg(`/pisa merge ${id}`));

      expect(sh(["git", "-C", repo, "cat-file", "-e", "main:out.txt"]).code).not.toBe(0);
      expect(store.effectsOf(id).some((e) => e.kind === "merge")).toBe(false);
      expect(ghCalls.length).toBe(0);
    } finally {
      if (supervised !== undefined) process.env.PISA_SUPERVISED = supervised;
    }
  });

  test("开启时任务成功后自动评审并 squash 合并", async () => {
    const head = sh(["git", "-C", repo, "rev-parse", "HEAD"]).out;
    const ghCalls: string[][] = [];
    const channel = new FakeChannel();
    let reviewCalls = 0;
    const deliverer: Deliverer = {
      async deliver(t: Task) {
        return { files: ["out.txt"], branch: t.branch ?? "pisa/x", prUrl: "https://github.com/o/r/pull/7", pushed: true };
      },
    };
    const router = build(
      true,
      ghCalls,
      () => {
        reviewCalls += 1;
      },
      {
        deliverer,
        channel,
        ghRunner: (args) => {
          ghCalls.push(args);
          if (args[1] === "pr" && args[2] === "view") {
            const fields = args[args.indexOf("--json") + 1] ?? "";
            if (fields === "state,mergeCommit") {
              return ok(JSON.stringify({ state: "MERGED", mergeCommit: "c".repeat(40) }));
            }
            return ok(snapshot("OPEN", head, GREEN));
          }
          if (args[1] === "pr" && args[2] === "diff") return ok("diff --git a/out.txt b/out.txt\n+hi\n");
          return ok();
        },
      },
    );

    await router.handle(msg("/pisa 新建 out.txt"));
    await router.drainOnce();
    await router.stop(5000);
    const id = store.recentTasks()[0]!.id;

    const merge = ghCalls.find((a) => a[1] === "pr" && a[2] === "merge")?.join(" ");
    expect(merge).toContain("--squash");
    expect(merge).toContain("--delete-branch");
    expect(reviewCalls).toBe(1);
    expect(store.effectsOf(id).some((e) => e.kind === "merge")).toBe(true);
    expect(store.effectsOf(id).some((e) => e.kind === "push")).toBe(true);
    expect(channel.sent.some((t) => t.includes("已合并"))).toBe(true);
  });
});
