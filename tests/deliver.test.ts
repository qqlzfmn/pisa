import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitDeliverer } from "../src/deliver";
import { EffectQueue } from "../src/effects";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { createWorktree, isSensitivePath, sh } from "../src/git";
import type { Config } from "../src/config";
import type { ChannelAdapter, Task, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";

const baseTask: Task = {
  id: "t_seed",
  source: "s",
  channel: "fake",
  chatId: "c1",
  requester: "u1",
  repo: "demo",
  prompt: "敏感路径",
  status: "queued",
  branch: null,
  prUrl: null,
  sessionId: null,
  baseRef: null,
  context: null,
  replyPr: null,
  replyIssue: null,
  replyRepo: null,
  readonly: false,
  reviewBase: null,
  summary: null,
  error: null,
  createdAt: 0,
  startedAt: null,
  endedAt: null,
  cancelRequested: false,
};

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-deliver-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "a.txt"), "base\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function makeCfg(repo: string, stateDir: string, push = false): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir,
  };
}

/** 工作副本里同时写入普通改动与敏感文件 */
function writeSecrets(workdir: string): void {
  writeFileSync(join(workdir, ".env"), "TOKEN=1\n");
  mkdirSync(join(workdir, ".github/workflows"), { recursive: true });
  writeFileSync(join(workdir, ".github/workflows/ci.yml"), "on: push\n");
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

describe("isSensitivePath", () => {
  test("凭据、私钥与 CI 工作流命中", () => {
    const hits = [
      ".github/workflows/ci.yml",
      ".github/actions/setup/action.yml",
      ".env",
      ".env.local",
      "config/.env.production",
      "deploy/server.pem",
      "certs/a.key",
      "keys/id_rsa",
      "keys/id_ed25519",
      ".npmrc",
      "service/.netrc",
      "config/secrets.json",
    ];
    expect(hits.filter((path) => !isSensitivePath(path))).toEqual([]);
  });

  test("普通源码与文档不误伤", () => {
    const misses = ["a.txt", "src/env.ts", "src/key.ts", "docs/workflows.md", ".github/ISSUE_TEMPLATE/bug.md", "keyboard.keymap"];
    expect(misses.filter(isSensitivePath)).toEqual([]);
  });
});

describe("GitDeliverer 敏感路径分拣", () => {
  let repo: string;
  let stateDir: string;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-deliver-state-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** 父分支上挂一个工作副本 */
  function setup(): string {
    expect(sh(["git", "-C", repo, "branch", "pisa/parent", "main"]).code).toBe(0);
    const workdir = join(stateDir, "wt");
    expect(createWorktree(repo, workdir, "pisa/parent").code).toBe(0);
    return workdir;
  }

  function outbox(deliverer: GitDeliverer): EffectQueue {
    const handlers = deliverer.effectHandlers();
    return new EffectQueue(new Store(":memory:")).register("push", handlers.push).register("pr", handlers.pr);
  }

  test("敏感文件不进入提交，回执给出 blocked 清单", async () => {
    const workdir = setup();
    writeFileSync(join(workdir, "a.txt"), "changed\n");
    writeSecrets(workdir);
    const cfg = makeCfg(repo, stateDir);
    const deliverer = new GitDeliverer(cfg);

    const res = await deliverer.deliver({ ...baseTask, id: "t_mixed", branch: "pisa/parent" }, workdir, cfg.repos[0]!, outbox(deliverer));

    expect(res.files).toEqual(["a.txt"]);
    expect(res.blocked).toEqual([".env", ".github/workflows/ci.yml"]);
    expect(res.pushed).toBe(false);
    const shown = sh(["git", "-C", workdir, "show", "--name-only", "--format=", "HEAD"]).out.split("\n").filter(Boolean);
    expect(shown).toEqual(["a.txt"]);
  });

  test("改动全被拦下时不产生空提交", async () => {
    const workdir = setup();
    writeSecrets(workdir);
    const cfg = makeCfg(repo, stateDir);
    const deliverer = new GitDeliverer(cfg);

    const res = await deliverer.deliver({ ...baseTask, id: "t_blocked", branch: "pisa/parent" }, workdir, cfg.repos[0]!, outbox(deliverer));

    expect(res.files).toEqual([]);
    expect(res.blocked).toEqual([".env", ".github/workflows/ci.yml"]);
    expect(res.pushed).toBe(false);
    expect(sh(["git", "-C", workdir, "rev-list", "--count", "HEAD"]).out).toBe("1");
    expect(sh(["git", "-C", workdir, "diff", "--cached", "--name-only"]).out).toBe("");
  });

  test("推送打开时只推送非敏感文件", async () => {
    const bare = mkdtempSync(join(tmpdir(), "pisa-deliver-bare-"));
    sh(["git", "init", "--bare", "-q", bare]);
    sh(["git", "-C", repo, "remote", "add", "origin", bare]);
    const workdir = setup();
    writeFileSync(join(workdir, "a.txt"), "changed\n");
    writeSecrets(workdir);
    const cfg = makeCfg(repo, stateDir, true);
    const deliverer = new GitDeliverer(cfg);

    try {
      const res = await deliverer.deliver({ ...baseTask, id: "t_push", branch: "pisa/parent" }, workdir, cfg.repos[0]!, outbox(deliverer));

      expect(res.pushed).toBe(true);
      expect(res.files).toEqual(["a.txt"]);
      expect(res.blocked).toEqual([".env", ".github/workflows/ci.yml"]);
      const shown = sh(["git", "--git-dir", bare, "show", "--name-only", "--format=", "pisa/parent"]).out.split("\n").filter(Boolean);
      expect(shown).toEqual(["a.txt"]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("交付回执列出被拦下的敏感路径", () => {
  let repo: string;
  let stateDir: string;

  beforeEach(() => {
    repo = makeRepo();
    stateDir = mkdtempSync(join(tmpdir(), "pisa-deliver-receipt-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("任务照常成功，回执追加一行", async () => {
    const cfg = makeCfg(repo, stateDir);
    const channel = new FakeChannel();
    const worker: WorkerRunner = {
      async run(_task, workdir): Promise<WorkerResult> {
        writeFileSync(join(workdir, "a.txt"), "changed\n");
        writeSecrets(workdir);
        return { ok: true, summary: "改完了", exitCode: 0 };
      },
    };
    const router = new Router({ cfg, store: new Store(":memory:"), worker, deliverer: new GitDeliverer(cfg), channel });

    await router.handle({ eventId: "e1", channel: "fake", chatId: "c1", userId: "u1", text: "/pisa 改一下" });
    await router.drainOnce();

    const text = channel.sent.at(-1)!.text;
    expect(text).toContain("完成");
    expect(text).toContain("改动 1 个文件：a.txt");
    expect(text).toContain("⚠️ 未提交的敏感路径：.env, .github/workflows/ci.yml");
  });
});
