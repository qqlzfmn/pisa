import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CAPABILITIES,
  capabilitiesFor,
  describeCapabilities,
  mergeCapabilities,
  normalizeCapabilities,
  parseManifest,
  runtimeManifest,
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

describe("normalizeCapabilities", () => {
  test("缺省与空对象都得到默认值（全拒）", () => {
    expect(normalizeCapabilities(undefined, "/base")).toEqual(DEFAULT_CAPABILITIES);
    expect(normalizeCapabilities({}, "/base")).toEqual(DEFAULT_CAPABILITIES);
    expect(DEFAULT_CAPABILITIES.gui).toBe(false);
    expect(DEFAULT_CAPABILITIES.domains).toEqual([]);
  });

  test("目录相对配置文件解析，`~/` 展开到用户主目录，重复项去掉", () => {
    const caps = normalizeCapabilities(
      { readDirs: ["data", "./data", "~/notes", "/abs", " ", "/abs"], writeDirs: ["out"] },
      "/base",
    );
    expect(caps.readDirs).toEqual(["/base/data", join(homedir(), "notes"), "/abs"]);
    expect(caps.writeDirs).toEqual(["/base/out"]);
  });

  test("域名小写、去通配前缀与尾点", () => {
    const caps = normalizeCapabilities({ domains: ["Example.COM", "*.npmjs.org", "a.io.", "a.io"] }, "/base");
    expect(caps.domains).toEqual(["example.com", "npmjs.org", "a.io"]);
  });
});

describe("mergeCapabilities / capabilitiesFor", () => {
  test("允许项取并集，声明只能加不能收窄", () => {
    const merged = mergeCapabilities(DEFAULT_CAPABILITIES, {
      ...DEFAULT_CAPABILITIES,
      readDirs: ["/a"],
      writeDirs: ["/w"],
      env: ["TOKEN"],
      domains: ["example.com"],
      gui: true,
      blockedCommands: ["frobnicate"],
    });
    expect(merged).toEqual({
      readDirs: ["/a"],
      writeDirs: ["/w"],
      env: ["TOKEN"],
      domains: ["example.com"],
      gui: true,
      blockedCommands: ["frobnicate"],
    });
    expect(mergeCapabilities(merged, { ...DEFAULT_CAPABILITIES, gui: false }).gui).toBe(true);
  });

  test("部署默认与仓库声明叠加，顺序稳定不重复", () => {
    const worker = normalizeCapabilities({ domains: ["github.com"], readDirs: ["/data"] }, "/base");
    const repo = normalizeCapabilities({ domains: ["github.com", "pypi.org"], writeDirs: ["/out"] }, "/base");
    expect(capabilitiesFor(worker, repo, undefined)).toEqual({
      readDirs: ["/data"],
      writeDirs: ["/out"],
      env: [],
      domains: ["github.com", "pypi.org"],
      gui: false,
      blockedCommands: [],
    });
  });
});

describe("runtimeManifest", () => {
  test("工作副本恒可写可读，env 是白名单与声明的并集", () => {
    const caps = mergeCapabilities(DEFAULT_CAPABILITIES, {
      ...DEFAULT_CAPABILITIES,
      readDirs: ["/data"],
      writeDirs: ["/out"],
      env: ["GH_TOKEN"],
    });
    expect(runtimeManifest(caps, { workdir: "/wt/t1", env: ["PATH", "GH_TOKEN"] })).toEqual({
      workdir: "/wt/t1",
      readDirs: ["/wt/t1", "/out", "/data"],
      writeDirs: ["/wt/t1", "/out"],
      env: ["PATH", "GH_TOKEN"],
      domains: [],
      gui: false,
      blockedCommands: [],
    });
  });
});

describe("parseManifest", () => {
  const manifest = runtimeManifest(DEFAULT_CAPABILITIES, { workdir: "/wt/t1", env: ["PATH"] });

  test("字符串与对象都能恢复", () => {
    expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(parseManifest(manifest)).toEqual(manifest);
  });

  test("缺字段、坏 JSON 一律视为缺失，由调用方按默认全拒处理", () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest("not json")).toBeNull();
    expect(parseManifest({ workdir: "/wt" })).toBeNull();
    expect(parseManifest({ ...manifest, gui: "yes" })).toBeNull();
  });

  test("非空清单能往返通过", () => {
    const full = runtimeManifest(
      mergeCapabilities(DEFAULT_CAPABILITIES, {
        ...DEFAULT_CAPABILITIES,
        domains: ["example.com"],
        gui: true,
        blockedCommands: ["x"],
      }),
      { workdir: "/wt/t1", env: ["PATH"] },
    );
    expect(parseManifest(JSON.stringify(full))).toEqual(full);
  });
});

describe("describeCapabilities", () => {
  test("空能力显示「无」", () => {
    expect(describeCapabilities(DEFAULT_CAPABILITIES)).toBe("可写 无 · 可读 无 · 密钥 无 · 域名 无 · GUI 关 · 禁止命令 无");
  });

  test("有声明时逐项列出", () => {
    const caps = normalizeCapabilities(
      { writeDirs: ["/out"], env: ["GH_TOKEN"], domains: ["example.com"], gui: true, blockedCommands: ["x"] },
      "/base",
    );
    expect(describeCapabilities(caps)).toBe("可写 /out · 可读 无 · 密钥 GH_TOKEN · 域名 example.com · GUI 开 · 禁止命令 x");
  });
});

describe("配置加载", () => {
  test("worker 与仓库层的 capabilities 都归一化成绝对路径", () => {
    const dir = tempDir();
    const path = join(dir, "pisa.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        worker: { capabilities: { readDirs: ["shared"], domains: ["github.com"] } },
        repos: [
          { alias: "a", path: "/repo/a", capabilities: { writeDirs: ["out"], domains: ["pypi.org"] } },
          { alias: "b", path: "/repo/b" },
        ],
      }),
    );
    const cfg = loadConfig(path);
    expect(cfg.worker.capabilities).toEqual({
      readDirs: [join(dir, "shared")],
      writeDirs: [],
      env: [],
      domains: ["github.com"],
      gui: false,
      blockedCommands: [],
    });
    expect(cfg.repos[0]?.capabilities?.writeDirs).toEqual([join(dir, "out")]);
    expect(cfg.repos[1]?.capabilities).toEqual(DEFAULT_CAPABILITIES);
  });
});
