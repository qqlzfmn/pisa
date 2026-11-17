import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitDeliverer, isSensitivePath } from "../src/deliver";
import { createWorktree, sh } from "../src/git";
import type { Config } from "../src/config";
import type { Task } from "../src/types";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-deliver-repo-"));
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
    delivery: { push: true, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir,
  };
}

const baseTask: Task = {
  id: "t_seed",
  source: "s",
  channel: "fake",
  chatId: "c1",
  requester: "u1",
  repo: "demo",
  prompt: "加一个文件",
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

describe("isSensitivePath", () => {
  test("命中凭据与 CI 定义", () => {
    for (const path of [
      ".env",
      ".env.local",
      "config/.env.production",
      ".github/workflows/ci.yml",
      ".github/actions/setup/action.yml",
      "certs/server.pem",
      "keys/deploy.key",
      "id_rsa",
      "deploy/id_ed25519",
      ".npmrc",
      "home/.netrc",
      "secrets.yaml",
      "src/secrets.ts",
    ]) {
      expect({ path, blocked: isSensitivePath(path) }).toEqual({ path, blocked: true });
    }
  });

  test("普通代码与文档放行", () => {
    for (const path of ["a.txt", "src/index.ts", "src/env.ts", "notes/keynotes.md", "identity.ts"]) {
      expect({ path, blocked: isSensitivePath(path) }).toEqual({ path, blocked: false });
    }
    // 非仓库根的 .github 不会在 CI 里执行
    expect(isSensitivePath("sub/.github/workflows/ci.yml")).toBe(false);
  });
});

describe("GitDeliverer 敏感路径分拣", () => {
  let repo: string;
  let bare: string;
  let stateDir: string;
  let cfg: Config;

  beforeEach(() => {
    repo = makeRepo();
    bare = mkdtempSync(join(tmpdir(), "pisa-deliver-bare-"));
    sh(["git", "init", "--bare", "-q", bare]);
    sh(["git", "-C", repo, "remote", "add", "origin", bare]);
    stateDir = mkdtempSync(join(tmpdir(), "pisa-deliver-state-"));
    cfg = makeCfg(repo, stateDir);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  function setup(): string {
    expect(sh(["git", "-C", repo, "branch", "pisa/t1", "main"]).code).toBe(0);
    const workdir = join(stateDir, "wt");
    expect(createWorktree(repo, workdir, "pisa/t1").code).toBe(0);
    return workdir;
  }

  test("敏感文件不进提交、不推送，其余改动照常推送", async () => {
    const workdir = setup();
    writeFileSync(join(workdir, "a.txt"), "a\n");
    writeFileSync(join(workdir, ".env"), "SECRET=1\n");
    mkdirSync(join(workdir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(workdir, ".github", "workflows", "ci.yml"), "on: push\n");

    const res = await new GitDeliverer(cfg).deliver({ ...baseTask, id: "t1", branch: "pisa/t1" }, workdir, cfg.repos[0]!);

    expect(sh(["git", "-C", workdir, "show", "--name-only", "--pretty=format:", "HEAD"]).out.split("\n")).toEqual(["a.txt"]);
    expect(res.files).toEqual(["a.txt"]);
    expect(res.blocked.sort()).toEqual([".env", ".github/workflows/ci.yml"]);
    expect(res.pushed).toBe(true);
    // 远端分支同样不含敏感内容
    expect(sh(["git", "--git-dir", bare, "cat-file", "-e", "pisa/t1:.env"]).code).not.toBe(0);
    expect(sh(["git", "--git-dir", bare, "cat-file", "-e", "pisa/t1:.github/workflows/ci.yml"]).code).not.toBe(0);
    expect(sh(["git", "--git-dir", bare, "cat-file", "-e", "pisa/t1:a.txt"]).code).toBe(0);
  });

  test("改动全被拦：不产生空提交、不推送", async () => {
    const workdir = setup();
    const before = sh(["git", "-C", workdir, "rev-parse", "HEAD"]).out;
    writeFileSync(join(workdir, ".env"), "SECRET=1\n");
    mkdirSync(join(workdir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(workdir, ".github", "workflows", "ci.yml"), "on: push\n");

    const res = await new GitDeliverer(cfg).deliver({ ...baseTask, id: "t1", branch: "pisa/t1" }, workdir, cfg.repos[0]!);

    expect(res.files).toEqual([]);
    expect(res.blocked.length).toBe(2);
    expect(res.pushed).toBe(false);
    expect(sh(["git", "-C", workdir, "rev-parse", "HEAD"]).out).toBe(before);
    expect(sh(["git", "--git-dir", bare, "rev-parse", "--verify", "pisa/t1"]).code).not.toBe(0);
  });

  test("改 .gitignore 放行也拦得住", async () => {
    const workdir = setup();
    writeFileSync(join(workdir, "a.txt"), "a\n");
    writeFileSync(join(workdir, ".gitignore"), "!.env\n");
    writeFileSync(join(workdir, ".env"), "SECRET=1\n");

    const res = await new GitDeliverer(cfg).deliver({ ...baseTask, id: "t1", branch: "pisa/t1" }, workdir, cfg.repos[0]!);

    expect(sh(["git", "-C", workdir, "show", "--name-only", "--pretty=format:", "HEAD"]).out.split("\n").sort()).toEqual([
      ".gitignore",
      "a.txt",
    ]);
    expect(res.blocked).toEqual([".env"]);
  });

  test("改名到敏感路径时整条改名都不提交", async () => {
    const workdir = setup();
    renameSync(join(workdir, "README.md"), join(workdir, "server.pem"));

    const res = await new GitDeliverer(cfg).deliver({ ...baseTask, id: "t1", branch: "pisa/t1" }, workdir, cfg.repos[0]!);

    expect(res.files).toEqual([]);
    expect(res.blocked.sort()).toEqual(["README.md", "server.pem"]);
    // 没有只提交新增路径，仓库里不会凭空多一份副本
    expect(sh(["git", "-C", workdir, "cat-file", "-e", "HEAD:server.pem"]).code).not.toBe(0);
    expect(sh(["git", "-C", workdir, "cat-file", "-e", "HEAD:README.md"]).code).toBe(0);
  });
});
