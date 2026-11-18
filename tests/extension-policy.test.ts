import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type Block = { block: true; reason: string };
type Handler = (event: { toolName?: string; input?: Record<string, unknown> }, ctx: Record<string, unknown>) => void | Block;

/**
 * 按给定策略重新加载扩展。扩展在 import 时读 env 决定策略，静态 import 只能拿到一次结果，
 * 所以这里用带查询串的动态 import 绕开模块缓存——这是测试专用的加载边界，没有别的入口。
 */
async function loadExtension(policy: string | undefined, workdir: string, progress: string) {
  process.env.PISA_CAPABILITIES = policy ?? "";
  process.env.PISA_WORKDIR = workdir;
  process.env.PISA_PROGRESS_FILE = progress;
  const mod = await import(`../extensions/pisa-worker.ts?case=${Math.random().toString(36).slice(2)}`);
  const handlers = new Map<string, Handler>();
  await mod.default({ on: (name: string, handler: Handler) => handlers.set(name, handler) });
  return (name: string, tool: string, input: Record<string, unknown> = {}): void | Block =>
    handlers.get(name)!({ toolName: tool, input }, {});
}

function caseDir(): { workdir: string; progress: string } {
  const dir = mkdtempSync(join(tmpdir(), "pisa-ext-"));
  roots.push(dir);
  return { workdir: dir, progress: join(dir, "progress.jsonl") };
}

function blockedEvents(file: string): Array<{ type: string; tool: string; detail: string; reason: string }> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { type: string; tool?: string; detail?: string; reason?: string })
    .filter((e) => e.type === "blocked") as Array<{ type: string; tool: string; detail: string; reason: string }>;
}

describe("扩展 · 默认全拒", () => {
  test("越界读写、联网与 GUI 都被拦下并记录原因", async () => {
    const { workdir, progress } = caseDir();
    const call = await loadExtension(undefined, workdir, progress);

    expect(call("tool_call", "bash", { command: "cat /etc/hosts" })).toMatchObject({ block: true });
    expect((call("tool_call", "bash", { command: "curl https://example.com" }) as Block).reason).toContain(
      "网络目标不在能力清单",
    );
    expect((call("tool_call", "write", { path: "/Users/lzf/notes.md" }) as Block).reason).toContain("写入范围之外");
    expect((call("tool_call", "browser", { url: "https://example.com" }) as Block).reason).toContain("GUI");
    expect(call("tool_call", "bash", { command: "ls -la" })).toBeUndefined();
    expect(call("tool_call", "write", { path: join(workdir, "a.ts") })).toBeUndefined();

    const events = blockedEvents(progress);
    expect(events).toHaveLength(4);
    expect(events[0]!.reason).toContain("读取范围之外");
    expect(events.map((e) => e.tool)).toEqual(["bash", "bash", "write", "browser"]);
  });
});

describe("扩展 · 显式放行", () => {
  test("清单内的目录、域名与 GUI 放行，清单外照旧拒绝", async () => {
    const { workdir, progress } = caseDir();
    const policy = JSON.stringify({ readPaths: ["/data/assets"], domains: ["example.com"], gui: true });
    const call = await loadExtension(policy, workdir, progress);

    expect(call("tool_call", "bash", { command: "cat /data/assets/a.png" })).toBeUndefined();
    expect(call("tool_call", "bash", { command: "curl https://api.example.com/v1" })).toBeUndefined();
    expect(call("tool_call", "browser", { url: "https://example.com" })).toBeUndefined();
    expect((call("tool_call", "write", { path: "/data/assets/a.ts" }) as Block).reason).toContain("写入范围之外");
    expect((call("tool_call", "bash", { command: "cat /data/secret/a.png" }) as Block).reason).toContain(
      "读取范围之外",
    );

    expect(blockedEvents(progress)).toHaveLength(2);
  });
});
