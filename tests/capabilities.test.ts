import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DENY_ALL,
  assertProfile,
  buildManifest,
  capabilityEnv,
  envAllowWithSecrets,
  mergeCapabilities,
  resolveCapabilities,
  type Capabilities,
} from "../src/capabilities";
import { loadConfig } from "../src/config";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-caps-"));
  roots.push(dir);
  return dir;
}

describe("mergeCapabilities", () => {
  test("缺省全拒", () => {
    expect(mergeCapabilities()).toEqual(DENY_ALL);
    expect(mergeCapabilities(undefined, null)).toEqual(DENY_ALL);
  });

  test("数组取并集并去重，gui 取或", () => {
    const merged = mergeCapabilities(
      { readPaths: ["/a"], secrets: ["GH_TOKEN"], domains: [], gui: false },
      { readPaths: ["/a", "/b"], domains: ["example.com"], gui: true },
      { secrets: ["GH_TOKEN", "DEPLOY_TOKEN"] },
    );
    expect(merged).toEqual({
      readPaths: ["/a", "/b"],
      secrets: ["GH_TOKEN", "DEPLOY_TOKEN"],
      domains: ["example.com"],
      gui: true,
    });
  });
});

describe("resolveCapabilities", () => {
  const sources = {
    global: { secrets: ["GLOBAL_TOKEN"] },
    repo: { readPaths: ["/data/repo"], domains: ["repo.example"] },
    profiles: {
      narrow: { readPaths: [], domains: [], gui: false },
      ui: { gui: true, domains: ["ui.example"] },
    },
  };

  test("未选档位时用仓库基线并合并全局", () => {
    expect(resolveCapabilities(sources)).toEqual({
      readPaths: ["/data/repo"],
      secrets: ["GLOBAL_TOKEN"],
      domains: ["repo.example"],
      gui: false,
    });
  });

  test("档位替换仓库基线：并集无法收紧，档位必须能收窄", () => {
    const narrow = resolveCapabilities(sources, "narrow");
    expect(narrow.readPaths).toEqual([]);
    expect(narrow.domains).toEqual([]);
    expect(narrow.secrets).toEqual(["GLOBAL_TOKEN"]);
  });

  test("档位只定义差异，全局基线仍然生效", () => {
    const ui = resolveCapabilities(sources, "ui");
    expect(ui.gui).toBe(true);
    expect(ui.domains).toEqual(["ui.example"]);
    expect(ui.secrets).toEqual(["GLOBAL_TOKEN"]);
  });

  test("未知档位报错并列出可选值", () => {
    expect(() => resolveCapabilities(sources, "nope")).toThrow(/未知能力档位：nope/);
    expect(() => resolveCapabilities(sources, "nope")).toThrow(/narrow, ui/);
    expect(() => assertProfile("nope", {})).toThrow(/仓库未配置 profiles/);
  });
});

describe("buildManifest", () => {
  const caps: Capabilities = {
    readPaths: ["/data/assets"],
    secrets: ["DEPLOY_TOKEN"],
    domains: ["example.com"],
    gui: false,
  };

  test("列出实际可读/可写目录与被禁类别，密钥只有名字", () => {
    const manifest = buildManifest({ taskId: "t_1", profile: "ui", workdir: "/work/wt", capabilities: caps });
    expect(manifest.readPaths).toContain("/work/wt");
    expect(manifest.readPaths).toContain("/data/assets");
    expect(manifest.readPaths).toContain("/usr");
    expect(manifest.writable).toContain("/work/wt");
    expect(manifest.writable).toContain("/tmp");
    expect(manifest.secrets).toEqual(["DEPLOY_TOKEN"]);
    expect(manifest.domains).toEqual(["example.com"]);
    expect(manifest.gui).toBe(false);
    expect(manifest.blocked.join("\n")).toContain("git push");
    expect(manifest.blocked.join("\n")).toContain("GUI");
  });

  test("相对 readPaths 以工作目录为基准", () => {
    const manifest = buildManifest({
      taskId: "t_2",
      profile: null,
      workdir: "/work/wt",
      capabilities: { ...caps, readPaths: ["../assets"] },
    });
    expect(manifest.readPaths).toContain("/work/assets");
  });
});

describe("capabilityEnv", () => {
  test("只带判定字段，不带密钥值", () => {
    const manifest = buildManifest({
      taskId: "t_3",
      profile: null,
      workdir: "/work/wt",
      capabilities: { readPaths: ["/data"], secrets: ["DEPLOY_TOKEN"], domains: ["a.example"], gui: true },
    });
    const env = capabilityEnv(manifest);
    const parsed = JSON.parse(env.PISA_CAPABILITIES!) as Record<string, unknown>;
    expect(parsed).toEqual({ taskId: "t_3", readPaths: manifest.readPaths, domains: ["a.example"], gui: true });
    expect(env.PISA_CAPABILITIES).not.toContain("DEPLOY_TOKEN");
  });
});

describe("envAllowWithSecrets", () => {
  test("密钥名并入白名单且去重", () => {
    expect(envAllowWithSecrets(["PATH", "GH_TOKEN"], ["GH_TOKEN", "DEPLOY_TOKEN"])).toEqual([
      "PATH",
      "GH_TOKEN",
      "DEPLOY_TOKEN",
    ]);
  });
});

describe("配置装载", () => {
  test("worker.capabilities 与仓库 profiles 从配置文件读取", () => {
    const dir = tempDir();
    const path = join(dir, "pisa.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        worker: { capabilities: { secrets: ["GH_TOKEN"], gui: false } },
        repos: [
          {
            alias: "demo",
            path: join(dir, "repo"),
            capabilities: { readPaths: ["/data"] },
            profiles: { ui: { gui: true } },
          },
        ],
      }),
    );
    const cfg = loadConfig(path);
    expect(cfg.worker.capabilities).toEqual({ secrets: ["GH_TOKEN"], gui: false });
    expect(cfg.repos[0]!.profiles?.ui).toEqual({ gui: true });
    const caps = resolveCapabilities(
      { global: cfg.worker.capabilities, repo: cfg.repos[0]!.capabilities, profiles: cfg.repos[0]!.profiles },
      "ui",
    );
    expect(caps.gui).toBe(true);
    expect(caps.secrets).toEqual(["GH_TOKEN"]);
    expect(caps.readPaths).toEqual([]);
  });
});
