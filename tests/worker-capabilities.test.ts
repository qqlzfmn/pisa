import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker, blockedEvents, workerEnv } from "../src/worker";
import type { Capabilities, CapabilityManifest } from "../src/capabilities";
import type { Task } from "../src/types";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-caps-run-"));
  roots.push(dir);
  return dir;
}

function taskWith(id: string, capability: string | null = null): Task {
  return {
    id,
    source: "test",
    channel: "cli",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "读一下环境变量",
    status: "queued",
    branch: null,
    prUrl: null,
    sessionId: null,
    baseRef: null,
    context: null,
    replyPr: null,
    replyIssue: null,
    replyRepo: null,
    capability,
    summary: null,
    error: null,
    createdAt: 0,
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
  };
}

/** 忽略 omp 参数、只打印环境的包装脚本 */
function printEnvScript(dir: string): string {
  const path = join(dir, "printenv.sh");
  writeFileSync(path, "#!/bin/sh\nexec env\n");
  chmodSync(path, 0o755);
  return path;
}

describe("Worker.run · 能力清单", () => {
  test("只放行声明的密钥变量，清单落盘并写入任务日志", async () => {
    const dir = tempDir();
    const state = join(dir, "state");
    const saved = { deploy: process.env.DEPLOY_TOKEN, other: process.env.UNLISTED_TOKEN };
    process.env.DEPLOY_TOKEN = "ALLOWED_VALUE";
    process.env.UNLISTED_TOKEN = "HIDDEN_VALUE";
    try {
      const lines: string[] = [];
      const worker = new Worker(
        { adapter: "omp", command: printEnvScript(dir), timeoutSec: 30, extraArgs: [], concurrency: 1 },
        state,
      );
      const capabilities: Capabilities = {
        readPaths: [join(dir, "assets")],
        secrets: ["DEPLOY_TOKEN"],
        domains: ["api.example.com"],
        gui: true,
      };
      const result = await worker.run(
        taskWith("t_caps", "ui"),
        dir,
        (line) => lines.push(line),
        () => false,
        false,
        capabilities,
      );
      const out = lines.join("\n");

      expect(result.ok).toBe(true);
      expect(out).toMatch(/^DEPLOY_TOKEN=ALLOWED_VALUE$/m);
      expect(out).not.toContain("HIDDEN_VALUE");
      expect(out).not.toMatch(/^UNLISTED_TOKEN=/m);

      const marker = out.split("\n").find((l) => l.startsWith("PISA_CAPABILITIES="));
      expect(marker).toBeDefined();
      const injected = JSON.parse(marker!.slice("PISA_CAPABILITIES=".length)) as Record<string, unknown>;
      expect(injected["taskId"]).toBe("t_caps");
      expect(injected["gui"]).toBe(true);
      expect(injected["domains"]).toEqual(["api.example.com"]);
      expect(injected["readPaths"]).toContain(join(dir, "assets"));
      expect(JSON.stringify(injected)).not.toContain("ALLOWED_VALUE");

      const manifestPath = join(state, "capabilities", "t_caps.json");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CapabilityManifest;
      expect(manifest.profile).toBe("ui");
      expect(manifest.gui).toBe(true);
      expect(manifest.secrets).toEqual(["DEPLOY_TOKEN"]);
      expect(manifest.writable).toContain(dir);
      expect(manifest.blocked.length).toBeGreaterThan(0);

      const log = readFileSync(join(state, "logs", "t_caps.log"), "utf8");
      expect(log).toContain('"stage":"capability"');
      expect(log).toContain("档位 ui");
    } finally {
      if (saved.deploy === undefined) delete process.env.DEPLOY_TOKEN;
      else process.env.DEPLOY_TOKEN = saved.deploy;
      if (saved.other === undefined) delete process.env.UNLISTED_TOKEN;
      else process.env.UNLISTED_TOKEN = saved.other;
    }
  });

  test("未传能力清单时按全拒处理：不继承任何密钥", async () => {
    const dir = tempDir();
    const saved = process.env.DEPLOY_TOKEN;
    process.env.DEPLOY_TOKEN = "HIDDEN_VALUE";
    try {
      const lines: string[] = [];
      const worker = new Worker(
        { adapter: "omp", command: printEnvScript(dir), timeoutSec: 30, extraArgs: [], concurrency: 1 },
        join(dir, "state"),
      );
      const result = await worker.run(taskWith("t_deny"), dir, (line) => lines.push(line), () => false);
      expect(result.ok).toBe(true);
      expect(lines.join("\n")).not.toContain("HIDDEN_VALUE");
      const manifest = JSON.parse(
        readFileSync(join(dir, "state", "capabilities", "t_deny.json"), "utf8"),
      ) as CapabilityManifest;
      expect(manifest.profile).toBeNull();
      expect(manifest.secrets).toEqual([]);
      expect(manifest.domains).toEqual([]);
      expect(manifest.gui).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.DEPLOY_TOKEN;
      else process.env.DEPLOY_TOKEN = saved;
    }
  });

  test("被拒操作随结果返回，供 Router 写审计", async () => {
    const dir = tempDir();
    const state = join(dir, "state");
    mkdirSync(join(state, "progress"), { recursive: true });
    writeFileSync(
      join(state, "progress", "t_audit.jsonl"),
      [
        JSON.stringify({ ts: 1, type: "blocked", tool: "bash", detail: "cat /etc/hosts", reason: "读取范围之外" }),
        JSON.stringify({ ts: 2, type: "tool", tool: "bash", detail: "ls" }),
        "not json",
      ].join("\n") + "\n",
    );
    const worker = new Worker(
      { adapter: "omp", command: printEnvScript(dir), timeoutSec: 30, extraArgs: [], concurrency: 1 },
      state,
    );
    const result = await worker.run(taskWith("t_audit"), dir, () => {}, () => false);
    expect(result.blocked).toEqual(["bash · cat /etc/hosts：读取范围之外"]);
  });
});

describe("blockedEvents", () => {
  test("只汇总 blocked 事件，半行与其它事件忽略", () => {
    const dir = tempDir();
    const file = join(dir, "p.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "blocked", tool: "browser", reason: "GUI 工具未放行" }),
        JSON.stringify({ type: "tool", tool: "bash" }),
        "{broken",
      ].join("\n"),
    );
    expect(blockedEvents(file)).toEqual(["browser：GUI 工具未放行"]);
  });

  test("文件不存在时返回空数组", () => {
    expect(blockedEvents(join(tempDir(), "missing.jsonl"))).toEqual([]);
  });
});

describe("workerEnv · 能力密钥", () => {
  test("密钥名与默认白名单一起生效", () => {
    expect(workerEnv(["PATH", "DEPLOY_TOKEN"], { PATH: "/bin", DEPLOY_TOKEN: "v" })).toEqual({
      PATH: "/bin",
      DEPLOY_TOKEN: "v",
    });
  });
});
