import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CAPABILITIES,
  capabilitiesFor,
  normalizeCapabilities,
  runtimeManifest,
} from "../src/capabilities";
import type { Block, Pi } from "../extensions/pisa-worker";

const dir = mkdtempSync(join(tmpdir(), "pisa-ext-"));
const workdir = join(dir, "wt");
const progress = join(dir, "progress.jsonl");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// 扩展在模块加载时读一次策略，静态导入无法先摆环境；这里故意测模块加载边界
const manifest = runtimeManifest(
  capabilitiesFor(normalizeCapabilities({ readDirs: ["/data"], domains: ["example.com"], gui: true }, dir)),
  { workdir, env: ["PATH"] },
);
process.env.PISA_CAPABILITIES = JSON.stringify(manifest);
process.env.PISA_WORKDIR = workdir;
process.env.PISA_PROGRESS_FILE = progress;

const { default: install, policyFromEnv } = await import("../extensions/pisa-worker");

const handlers: Record<string, Parameters<Pi["on"]>[1]> = {};
install({ on: (name, handler) => void (handlers[name] = handler) });
const call = (toolName: string, input: Record<string, unknown>) =>
  handlers.tool_call!({ toolName, input }, {}) as Block | undefined;

type Event = { type: string; tool?: string; detail?: string; reason?: string };
const events = (): Event[] =>
  readFileSync(progress, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);

describe("pisa-worker 扩展", () => {
  test("越界 bash 被拦下，原因与命令写进 progress", () => {
    const result = call("bash", { command: "cat /etc/passwd" });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("不可读");
    const blocked = events().at(-1)!;
    expect(blocked).toMatchObject({ type: "blocked", tool: "bash", detail: "cat /etc/passwd" });
    expect(blocked.reason).toContain("不可读");
  });

  test("清单放行的命令照常执行并记录 tool 事件", () => {
    expect(call("bash", { command: "cat /data/report.csv" })).toBeUndefined();
    expect(call("bash", { command: "curl https://api.example.com/x" })).toBeUndefined();
    expect(call("bash", { command: "open -a Safari" })).toBeUndefined();
    expect(events().at(-1)).toMatchObject({ type: "tool", tool: "bash" });
  });

  test("未放行的域名仍拒绝", () => {
    const result = call("bash", { command: "curl https://other.com" });
    expect(result?.reason).toContain("域");
  });

  test("文件工具按读/写分类校验", () => {
    expect(call("write", { path: join(workdir, "a.ts") })).toBeUndefined();
    expect(call("write", { path: "/etc/x" })?.reason).toContain("不可写");
    expect(call("read", { path: "/data/x.csv" })).toBeUndefined();
    expect(call("read", { path: "/root/x" })?.reason).toContain("不可读");
  });

  test("没有清单时默认全拒", () => {
    expect(policyFromEnv({})).toEqual({
      workdir: "",
      readDirs: [],
      writeDirs: [],
      domains: [],
      gui: false,
      blockedCommands: [],
    });
    expect(DEFAULT_CAPABILITIES).toEqual({
      readDirs: [],
      writeDirs: [],
      env: [],
      domains: [],
      gui: false,
      blockedCommands: [],
    });
  });
});
