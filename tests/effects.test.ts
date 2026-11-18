import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitDeliverer } from "../src/deliver";
import {
  EFFECT_MAX_DELAY_MS,
  EffectQueue,
  deliveryEffectHandlers,
  effectDelay,
  type EffectHandlers,
  type PrPayload,
} from "../src/effects";
import { createWorktree, sh, type ExecResult } from "../src/git";
import { Store } from "../src/store";
import type { Config } from "../src/config";
import type { Task } from "../src/types";

function ok(out = ""): ExecResult {
  return { code: 0, out, err: "" };
}

describe("EffectQueue", () => {
  let store: Store;
  let clock: number;

  beforeEach(() => {
    store = new Store(":memory:");
    clock = 1_000;
  });

  afterEach(() => store.close());

  function queue(handlers: EffectHandlers, onDone?: (kind: string, payload: unknown, result: unknown) => void): EffectQueue {
    return new EffectQueue(store, { handlers, now: () => clock, onDone });
  }

  test("同一 (kind, key) 只入队一次", () => {
    const effects = queue({});
    expect(effects.enqueue("pr", "demo:pisa/t_1", { a: 1 })).toBe(true);
    expect(effects.enqueue("pr", "demo:pisa/t_1", { a: 2 })).toBe(false);
    expect(store.dueEffects(clock)).toHaveLength(1);
    // 首次写入的 payload 不被覆盖
    expect(store.effectByKey("pr", "demo:pisa/t_1")!.payload).toBe('{"a":1}');
  });

  test("成功一次后不再执行，重放取回同一结果", async () => {
    let calls = 0;
    const effects = queue({
      pr: async () => {
        calls += 1;
        return "https://github.com/o/r/pull/7";
      },
    });
    effects.enqueue("pr", "demo:pisa/t_1", {});

    expect(await effects.runNow("pr", "demo:pisa/t_1")).toEqual({ ok: true, result: "https://github.com/o/r/pull/7" });
    expect(await effects.runNow("pr", "demo:pisa/t_1")).toEqual({ ok: true, result: "https://github.com/o/r/pull/7" });
    expect(calls).toBe(1);
    expect(store.effectByKey("pr", "demo:pisa/t_1")!.doneAt).toBe(clock);
  });

  test("失败按 2s→60s 退避，未到点不重试", async () => {
    let calls = 0;
    const effects = queue({
      push: async () => {
        calls += 1;
        throw new Error("推送失败: no token");
      },
    });
    effects.enqueue("push", "pisa/t_1@abc", {});
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 7; attempt += 1) {
      expect(await effects.runDue()).toBe(1);
      const row = store.effectByKey("push", "pisa/t_1@abc")!;
      expect(row.attempts).toBe(attempt);
      expect(row.lastError).toBe("推送失败: no token");
      delays.push(row.nextAt - clock);

      // 未到 nextAt：不执行
      expect(await effects.runDue()).toBe(0);
      expect(calls).toBe(attempt);
      clock = row.nextAt;
    }

    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
    expect(effectDelay(9)).toBe(EFFECT_MAX_DELAY_MS);
  });

  test("重启后新队列接着跑未完成的 effect", async () => {
    const stale = queue({});
    stale.enqueue("comment", "o/r#12:pr:t_1", { body: "hi" });

    // 新进程：同一份库，新的队列实例
    let calls = 0;
    const revived = queue({
      comment: async () => {
        calls += 1;
        return "posted";
      },
    });
    expect(await revived.runDue()).toBe(1);
    expect(calls).toBe(1);
    expect(store.effectByKey("comment", "o/r#12:pr:t_1")!.doneAt).toBe(clock);

    // 已完成的不会再跑
    expect(await revived.runDue()).toBe(0);
    expect(calls).toBe(1);
  });

  test("完成后回调只在该次成功时触发", async () => {
    const done: string[] = [];
    let succeed = false;
    const effects = queue(
      {
        pr: async () => {
          if (!succeed) throw new Error("网络错误");
          return "https://github.com/o/r/pull/9";
        },
      },
      (kind, _payload, result) => done.push(`${kind}:${String(result)}`),
    );
    effects.enqueue("pr", "demo:pisa/t_1", {});
    await effects.runDue();
    expect(done).toEqual([]);

    succeed = true;
    clock = store.effectByKey("pr", "demo:pisa/t_1")!.nextAt;
    await effects.runDue();
    expect(done).toEqual(["pr:https://github.com/o/r/pull/9"]);
  });

  test("未注册的 kind 记失败而不是丢掉", async () => {
    const effects = queue({});
    effects.enqueue("pr", "demo:pisa/t_1", {});
    expect(await effects.runDue()).toBe(1);
    const row = store.effectByKey("pr", "demo:pisa/t_1")!;
    expect(row.doneAt).toBeNull();
    expect(row.lastError).toBe("未注册的 effect 类型：pr");
  });
});

describe("GitDeliverer 通过 outbox 执行", () => {
  let root: string;
  let repo: string;
  let bare: string;
  let store: Store;
  let clock: number;
  let cfg: Config;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pisa-effects-"));
    repo = join(root, "repo");
    bare = join(root, "bare.git");
    mkdirSync(repo);
    sh(["git", "init", "-q", "-b", "main"], repo);
    writeFileSync(join(repo, "README.md"), "hi\n");
    sh(["git", "-C", repo, "add", "-A"]);
    sh(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
    sh(["git", "init", "-q", "--bare", bare], root);
    store = new Store(":memory:");
    clock = 1_000;
    cfg = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: [], repos: [] },
      repos: [{ alias: "demo", path: repo, baseBranch: "main", remote: "https://github.com/o/r.git" }],
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      delivery: { push: true, pr: true, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      stateDir: root,
    };
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function queue(handlers: EffectHandlers): EffectQueue {
    return new EffectQueue(store, { handlers, now: () => clock });
  }

  function task(over: Partial<Task> = {}): Task {
    return {
      id: "t_1",
      source: "s",
      channel: "fake",
      chatId: "c1",
      requester: "u1",
      repo: "demo",
      prompt: "改点东西",
      status: "running",
      branch: "pisa/t_1",
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
      startedAt: 0,
      endedAt: null,
      cancelRequested: false,
      ...over,
    };
  }

  function setupWorktree(id = "t_1"): string {
    const workdir = join(root, "wt", id);
    expect(createWorktree(repo, workdir, `pisa/${id}`).code).toBe(0);
    writeFileSync(join(workdir, "out.txt"), "hi\n");
    return workdir;
  }

  test("推送失败留在队列里，退避后重试成功", async () => {
    const workdir = setupWorktree();
    const deliverer = new GitDeliverer(cfg, { hasGh: () => true });

    // 没有 origin：真实推送会失败
    const first = await deliverer.deliver(task(), workdir, cfg.repos[0]!, queue(deliveryEffectHandlers()));
    expect(first.pushed).toBe(false);
    const key = store.dueEffects(clock + 10_000)[0]!;
    expect(key.kind).toBe("push");
    expect(key.attempts).toBe(1);
    expect(key.nextAt).toBe(clock + 2_000);

    // 修正远端后按退避重试
    sh(["git", "-C", repo, "remote", "add", "origin", bare]);
    clock = key.nextAt;
    const retry = queue(deliveryEffectHandlers());
    expect(await retry.runDue()).toBe(1);
    const row = store.effectByKey("push", key.key)!;
    expect(row.doneAt).toBe(clock);
    expect(sh(["git", "--git-dir", bare, "rev-parse", "--verify", "pisa/t_1"]).code).toBe(0);
  });

  test("PR 建完没落库就崩：重放复用已有 PR，不再新建", async () => {
    sh(["git", "-C", repo, "remote", "add", "origin", bare]);
    const url = "https://github.com/o/r/pull/7";

    // 上次执行到「PR 已建、done 未写」：库里仍是 pending，远端已有该分支的 PR
    const payload: PrPayload = {
      taskId: "t_1",
      alias: "demo",
      repoPath: repo,
      base: "main",
      head: "pisa/t_1",
      title: "pisa: 改点东西",
      body: "任务号：t_1",
    };
    const crashed = queue({});
    crashed.enqueue("pr", "demo:pisa/t_1", payload);

    let created = 0;
    const replayed = queue(
      deliveryEffectHandlers({
        findPr: (_repo, head) => (head === "pisa/t_1" ? url : null),
        createPr: () => {
          created += 1;
          return ok(url);
        },
      }),
    );
    expect(await replayed.runDue()).toBe(1);
    expect(created).toBe(0);
    expect(store.effectByKey("pr", "demo:pisa/t_1")!.result).toBe(JSON.stringify(url));
  });

  test("同一任务二次交付不会建第二个 PR", async () => {
    sh(["git", "-C", repo, "remote", "add", "origin", bare]);
    const workdir = setupWorktree();
    const urls = ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"];
    let created = 0;
    const effects = queue(
      deliveryEffectHandlers({
        findPr: () => null,
        createPr: () => ok(urls[created++]!),
      }),
    );
    const deliverer = new GitDeliverer(cfg, { hasGh: () => true });

    const first = await deliverer.deliver(task(), workdir, cfg.repos[0]!, effects);
    expect(first.prUrl).toBe("https://github.com/o/r/pull/1");

    // 模拟 prUrl 没写进 tasks：库里仍是 null，重跑又有新改动
    writeFileSync(join(workdir, "out.txt"), "hi again\n");
    const second = await deliverer.deliver(task(), workdir, cfg.repos[0]!, effects);

    expect(created).toBe(1);
    expect(second.prUrl).toBe("https://github.com/o/r/pull/1");
  });
});
