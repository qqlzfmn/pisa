import { describe, expect, test } from "bun:test";
import {
  defaultRuntime,
  hostAllowed,
  outsideRoots,
  parseCapabilitySpec,
  resolveCapabilities,
} from "../src/capabilities";

describe("defaultRuntime", () => {
  test("默认只允许 workdir 读写，网络与 GUI 关闭", () => {
    const caps = defaultRuntime("/work/repo");
    expect(caps.read).toEqual(["/work/repo"]);
    expect(caps.write).toEqual(["/work/repo"]);
    expect(caps.secrets).toEqual([]);
    expect(caps.domains).toEqual([]);
    expect(caps.gui).toBe(false);
    expect(caps.blocked.length).toBeGreaterThan(0);
  });
});

describe("resolveCapabilities", () => {
  test("显式目录按仓库根解析，write 并入 read，重复项去重", () => {
    const caps = resolveCapabilities("/work/repo", "/work/repo", {
      read: ["data", "/data"],
      write: ["tmp"],
      domains: ["Example.COM.", "example.com"],
      deny: ["npm publish", "npm publish"],
    });
    expect(caps.read).toEqual(["/work/repo", "/work/repo/tmp", "/work/repo/data", "/data"]);
    expect(caps.write).toEqual(["/work/repo", "/work/repo/tmp"]);
    expect(caps.domains).toEqual(["example.com"]);
    expect(caps.deny).toEqual(["npm publish"]);
    expect(caps.blocked).toContain("自定义禁止：npm publish");
  });

  test("gui 只有显式 true 才开启", () => {
    expect(resolveCapabilities("/w", "/w", { gui: true }).gui).toBe(true);
    expect(resolveCapabilities("/w", "/w", {}).gui).toBe(false);
    expect(resolveCapabilities("/w", "/w", null).gui).toBe(false);
  });
});

describe("parseCapabilitySpec", () => {
  test("只接受对象、字符串数组与布尔 gui", () => {
    expect(parseCapabilitySpec(null)).toBeNull();
    expect(parseCapabilitySpec("x")).toBeNull();
    expect(
      parseCapabilitySpec({
        read: [" /data ", 1, null],
        gui: "yes",
        deny: ["npm publish"],
        unknown: "ignored",
      }),
    ).toEqual({ read: ["/data"], deny: ["npm publish"] });
  });
});

describe("hostAllowed", () => {
  test("精确匹配与通配子域名", () => {
    expect(hostAllowed("example.com", ["example.com"])).toBe(true);
    expect(hostAllowed("example.com", ["*.example.com"])).toBe(false);
    expect(hostAllowed("api.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("evil-example.com", ["example.com"])).toBe(false);
  });
});

describe("outsideRoots", () => {
  test("目录本身与子路径放行，前缀相近的目录拦截", () => {
    expect(outsideRoots("/work/repo", ["/work/repo"], "/")).toBeNull();
    expect(outsideRoots("/work/repo/a.txt", ["/work/repo"], "/")).toBeNull();
    expect(outsideRoots("/work/repo2/a.txt", ["/work/repo"], "/")).not.toBeNull();
    expect(outsideRoots("/etc/passwd", ["/work/repo"], "/")).toContain("路径超出可访问目录");
  });
});
