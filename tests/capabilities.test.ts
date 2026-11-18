import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, type Config, type RepoConfig } from "../src/config";
import {
  capabilitiesForTask,
  capabilityManifest,
  capabilitySummary,
  capabilityText,
  resolveCapabilities,
} from "../src/capabilities";

const REPO: RepoConfig = { alias: "demo", path: "/repo/demo" };
const worker = (patch: Partial<Config["worker"]> = {}): Config["worker"] => ({ ...DEFAULT_CONFIG.worker, ...patch });

describe("resolveCapabilities", () => {
  test("默认全部关闭，环境变量只保留内置白名单", () => {
    const caps = resolveCapabilities(worker(), REPO);
    expect(caps.readDirs).toEqual([]);
    expect(caps.writeDirs).toEqual([]);
    expect(caps.domains).toEqual([]);
    expect(caps.gui).toBe(false);
    expect(caps.blocked).toEqual([]);
    expect(caps.env).toContain("PATH");
    expect(caps.env).not.toContain("GH_TOKEN");
  });

  test("全局、仓库、任务三层叠加，目录按仓库根解析", () => {
    const caps = resolveCapabilities(
      worker({ capabilities: { env: ["GLOBAL_KEY"], domains: ["https://api.example.com"] } }),
      {
        ...REPO,
        capabilities: {
          read: ["../shared", "/data/fixtures"],
          write: ["logs"],
          env: ["REPO_KEY"],
          gui: true,
          blocked: ["npm publish"],
        },
      },
      { read: ["vendor"], env: ["TASK_KEY"], domains: ["uploads.example.com:8443"] },
    );
    expect(caps.readDirs).toEqual(["/repo/shared", "/data/fixtures", "/repo/demo/vendor"]);
    expect(caps.writeDirs).toEqual(["/repo/demo/logs"]);
    expect(caps.env).toEqual(expect.arrayContaining(["PATH", "GLOBAL_KEY", "REPO_KEY", "TASK_KEY"]));
    expect(caps.domains).toEqual(["api.example.com", "uploads.example.com"]);
    expect(caps.gui).toBe(true);
    expect(caps.blocked).toEqual(["npm publish"]);
  });

  test("任务层不能撤销仓库层的放行，未声明的域名仍为空", () => {
    const caps = resolveCapabilities(worker(), { ...REPO, capabilities: { gui: true } }, {});
    expect(caps.gui).toBe(true);
    expect(caps.domains).toEqual([]);
  });
});

describe("capabilitiesForTask", () => {
  test("任务快照优先于当前配置", () => {
    const snapshot = resolveCapabilities(worker(), REPO, { domains: ["old.example.com"] });
    const caps = capabilitiesForTask(
      { repo: "demo", capabilities: snapshot },
      worker({ capabilities: { domains: ["new.example.com"] } }),
      [REPO],
    );
    expect(caps.domains).toEqual(["old.example.com"]);
  });

  test("旧任务没有快照时按仓库配置解析", () => {
    const caps = capabilitiesForTask(
      { repo: "demo" },
      worker(),
      [{ ...REPO, capabilities: { read: ["/data/fixtures"] } }],
    );
    expect(caps.readDirs).toEqual(["/data/fixtures"]);
  });
});

describe("capabilityManifest", () => {
  test("始终保留 worktree 与系统临时目录", () => {
    const manifest = capabilityManifest(resolveCapabilities(worker(), REPO), "/state/worktrees/t1");
    expect(manifest.readDirs).toEqual(expect.arrayContaining(["/state/worktrees/t1", tmpdir(), "/tmp"]));
    expect(manifest.writeDirs).toEqual(expect.arrayContaining(["/state/worktrees/t1", tmpdir(), "/tmp"]));
  });

  test("声明目录去重后保留", () => {
    const caps = resolveCapabilities(worker(), REPO, { read: ["/data/fixtures"], write: ["/data/out"] });
    const manifest = capabilityManifest(caps, "/state/worktrees/t1");
    expect(manifest.readDirs).toContain("/data/fixtures");
    expect(manifest.writeDirs).toContain("/data/out");
    expect(new Set(manifest.readDirs).size).toBe(manifest.readDirs.length);
  });
});

describe("capabilityText", () => {
  test("摘要把关闭项写成拒绝", () => {
    const caps = resolveCapabilities(worker(), REPO);
    expect(capabilitySummary(caps)).toContain("GUI 禁止");
    expect(capabilityText(caps)).toContain("图形界面：禁止");
    expect(capabilityText(caps)).toContain("可访问域名：无（网络命令一律拒绝）");
  });

  test("放行项写进事实清单", () => {
    const caps = resolveCapabilities(worker(), REPO, {
      read: ["/data/fixtures"],
      domains: ["api.example.com"],
      gui: true,
      blocked: ["npm publish"],
    });
    const text = capabilityText(caps, "/state/worktrees/t1");
    expect(text).toContain("/data/fixtures");
    expect(text).toContain("api.example.com");
    expect(text).toContain("图形界面：允许");
    expect(text).toContain("npm publish");
  });
});
