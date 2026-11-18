import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BLOCKED,
  capabilityManifest,
  capabilitySource,
  formatAudit,
  formatCapability,
  readViolations,
  resolveCapabilities,
  type TaskAudit,
} from "../src/capabilities";
import { Store } from "../src/store";
import type { Task } from "../src/types";

const config = {
  capabilities: { read: ["../shared"], env: ["NPM_TOKEN"], gui: true, domains: ["github.com"], blocked: ["docker"] },
  repos: [
    { alias: "demo", path: "/work/demo", capabilities: { write: ["build"], env: ["GH_TOKEN"], gui: false } },
    { alias: "other", path: "/work/other" },
  ],
};

const source = capabilitySource(config);

const task: Task = {
  id: "t_1",
  source: "test",
  channel: "cli",
  chatId: "c1",
  requester: "u1",
  repo: "demo",
  prompt: "改一下",
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

describe("resolveCapabilities", () => {
  test("没有声明时全部默认拒绝", () => {
    const caps = resolveCapabilities(undefined, "demo");
    expect(caps).toEqual({ read: [], write: [], env: [], domains: [], gui: false, blocked: [] });
    expect(formatCapability(caps)).toContain("gui=off");
    expect(formatCapability(caps)).toContain("blocked=git push");
  });

  test("全局与仓库声明按并集合并，gui 由仓库覆盖", () => {
    const caps = resolveCapabilities(source, "demo");
    expect(caps.read).toEqual(["../shared"]);
    expect(caps.write).toEqual(["build"]);
    expect(caps.env).toEqual(["NPM_TOKEN", "GH_TOKEN"]);
    expect(caps.domains).toEqual(["github.com"]);
    expect(caps.blocked).toEqual(["docker"]);
    expect(caps.gui).toBe(false);
  });

  test("仓库没有声明时继承全局", () => {
    const caps = resolveCapabilities(source, "other");
    expect(caps.read).toEqual(["../shared"]);
    expect(caps.gui).toBe(true);
    expect(caps.env).toEqual(["NPM_TOKEN"]);
  });
});

describe("capabilityManifest", () => {
  test("目录按工作目录解析，工作目录恒在列，env 与基线合并", () => {
    const manifest = capabilityManifest({
      repo: "demo",
      workdir: "/work/repo",
      envAllow: ["PATH", "HOME"],
      caps: resolveCapabilities(source, "demo"),
    });
    expect(manifest.repo).toBe("demo");
    expect(manifest.workdir).toBe("/work/repo");
    expect(manifest.read).toEqual(["/work/repo", "/work/shared"]);
    expect(manifest.write).toEqual(["/work/repo", "/work/repo/build"]);
    expect(manifest.env).toEqual(["PATH", "HOME", "NPM_TOKEN", "GH_TOKEN"]);
    expect(manifest.gui).toBe(false);
    expect(manifest.builtin).toEqual([...DEFAULT_BLOCKED]);
  });

  test("绝对路径声明保持原样", () => {
    const manifest = capabilityManifest({
      repo: "demo",
      workdir: "/work/repo",
      envAllow: [],
      caps: { read: ["/data/shared"], write: [], env: [], domains: [], gui: false, blocked: [] },
    });
    expect(manifest.read).toContain("/data/shared");
    expect(manifest.env).toEqual([]);
  });
});

describe("formatAudit", () => {
  const manifest = capabilityManifest({
    repo: "demo",
    workdir: "/work/repo",
    envAllow: ["PATH"],
    caps: resolveCapabilities(source, "demo"),
  });

  test("没有拦截时只报规模", () => {
    const text = formatAudit({ capabilities: manifest, violations: [] });
    expect(text).toContain("可写 2 个目录");
    expect(text).toContain("拦截 0 次");
  });

  test("有拦截时带最近一条原因", () => {
    const text = formatAudit({
      capabilities: manifest,
      violations: [{ tool: "bash", detail: "curl https://evil.com", reason: "域名不在能力清单：evil.com" }],
    });
    expect(text).toContain("拦截 1 次");
    expect(text).toContain("bash：域名不在能力清单：evil.com");
  });
});

describe("readViolations", () => {
  test("只取 blocked 事件，坏行跳过", () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-progress-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", sessionId: "s1" }),
        JSON.stringify({ type: "blocked", tool: "bash", detail: "git push", reason: "禁止 git push" }),
        "{半行",
        JSON.stringify({ type: "blocked", tool: "write", detail: "/etc/hosts", reason: "路径超出能力范围" }),
      ].join("\n"),
    );
    expect(readViolations(file)).toEqual([
      { tool: "bash", detail: "git push", reason: "禁止 git push" },
      { tool: "write", detail: "/etc/hosts", reason: "路径超出能力范围" },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("文件不存在时返回空数组", () => {
    expect(readViolations("/nonexistent/pisa/progress.jsonl")).toEqual([]);
  });
});

describe("Store · 审计", () => {
  test("写入后读回同一份审计", () => {
    const store = new Store(":memory:");
    store.insertTask(task);
    const audit: TaskAudit = {
      capabilities: capabilityManifest({
        repo: "demo",
        workdir: "/work/repo",
        envAllow: ["PATH"],
        caps: resolveCapabilities(source, "demo"),
      }),
      violations: [{ tool: "bash", detail: "open .", reason: "未开启 GUI 能力：open" }],
    };
    expect(store.get(task.id)?.audit).toBeNull();
    store.setAudit(task.id, audit);
    expect(store.get(task.id)?.audit).toEqual(audit);
    store.close();
  });
});
