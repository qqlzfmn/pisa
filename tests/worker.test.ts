import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, DEFAULT_ENV_ALLOW, loadConfig } from "../src/config";
import { Worker, readBlocked, workerEnv } from "../src/worker";
import type { Task } from "../src/types";

const task: Task = {
  id: "t_env",
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
  summary: null,
  error: null,
  createdAt: 0,
  startedAt: null,
  endedAt: null,
  cancelRequested: false,
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-env-"));
  roots.push(dir);
  return dir;
}

describe("workerEnv", () => {
  test("只保留白名单里的键，凭据不外泄", () => {
    const env = workerEnv(DEFAULT_ENV_ALLOW, {
      PATH: "/usr/bin",
      HOME: "/home/u",
      PISA_TELEGRAM_TOKEN: "SECRET",
      GH_TOKEN: "SECRET",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.PISA_TELEGRAM_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });

  test("白名单外的键即使存在也不复制，缺省键不产生空值", () => {
    expect(workerEnv(["GH_TOKEN", "LANG"], { GH_TOKEN: "SECRET", LANG: "zh_CN.UTF-8" })).toEqual({
      GH_TOKEN: "SECRET",
      LANG: "zh_CN.UTF-8",
    });
    expect(workerEnv(["NOPE"], {})).toEqual({});
  });

  test("配置文件只改 worker.command 时 envAllow 仍取默认值", () => {
    const dir = tempDir();
    const path = join(dir, "pisa.config.json");
    writeFileSync(path, JSON.stringify({ worker: { command: "omp" } }));
    const cfg = loadConfig(path);
    expect(cfg.worker.envAllow).toEqual([...DEFAULT_ENV_ALLOW]);
    expect(DEFAULT_CONFIG.worker.envAllow).toEqual([...DEFAULT_ENV_ALLOW]);
  });
});

describe("Worker.run", () => {
  test("能力清单决定可继承的环境变量，并注入 manifest 与 GUI 开关", async () => {
    const dir = tempDir();
    const printEnv = join(dir, "printenv.sh");
    writeFileSync(printEnv, "#!/bin/sh\nexec env\n");
    chmodSync(printEnv, 0o755);

    const saved = process.env.DEMO_TOKEN;
    process.env.DEMO_TOKEN = "cap-secret";
    try {
      const lines: string[] = [];
      const worker = new Worker(
        {
          adapter: "omp",
          command: printEnv,
          timeoutSec: 30,
          extraArgs: [],
          concurrency: 1,
          capabilities: { env: ["DEMO_TOKEN"], domains: ["example.com"], gui: true },
        },
        join(dir, "state"),
      );
      const result = await worker.run(task, dir, (line) => lines.push(line), () => false);
      const out = lines.join("\n");
      expect(result.ok).toBe(true);
      expect(out).toMatch(/^DEMO_TOKEN=cap-secret$/m);
      expect(out).toMatch(/^PISA_CAP_GUI=1$/m);

      const raw = out.split("\n").find((line) => line.startsWith("PISA_CAPABILITIES="));
      expect(raw).toBeDefined();
      const manifest = JSON.parse(raw!.slice("PISA_CAPABILITIES=".length)) as {
        domains: string[];
        gui: boolean;
        readDirs: string[];
      };
      expect(manifest.domains).toEqual(["example.com"]);
      expect(manifest.gui).toBe(true);
      expect(manifest.readDirs).toContain(dir);
      expect(result.blocked).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.DEMO_TOKEN;
      else process.env.DEMO_TOKEN = saved;
    }
  });

  test("恢复执行只回收新增的拦截记录", () => {
    const dir = tempDir();
    const path = join(dir, "progress.jsonl");
    const first = '{"type":"blocked","tool":"bash","detail":"curl a","reason":"域名未放行：a"}\n';
    const second = '{"type":"blocked","tool":"bash","detail":"curl b","reason":"域名未放行：b"}\n';
    writeFileSync(path, first);
    writeFileSync(path, first + second);
    expect(readBlocked(path)).toHaveLength(2);
    expect(readBlocked(path, Buffer.byteLength(first))).toEqual([
      { tool: "bash", detail: "curl b", reason: "域名未放行：b" },
    ]);
  });

  test("回收进度文件里的拦截记录", async () => {
    const dir = tempDir();
    const script = join(dir, "fake-worker.sh");
    writeFileSync(
      script,
      `#!/bin/sh
printf '%s\\n' '{"type":"blocked","tool":"bash","detail":"curl https://example.com","reason":"域名未放行：example.com"}' >> "$PISA_PROGRESS_FILE"
printf '%s\\n' '{"type":"blocked","tool":"read","detail":"/etc/passwd","reason":"路径不在允许目录内"}' >> "$PISA_PROGRESS_FILE"
echo done
`,
    );
    chmodSync(script, 0o755);

    const worker = new Worker(
      { adapter: "omp", command: script, timeoutSec: 30, extraArgs: [], concurrency: 1 },
      join(dir, "state"),
    );
    const result = await worker.run(task, dir, () => {}, () => false);
    expect(result.ok).toBe(true);
    expect(result.blocked).toEqual([
      { tool: "bash", detail: "curl https://example.com", reason: "域名未放行：example.com" },
      { tool: "read", detail: "/etc/passwd", reason: "路径不在允许目录内" },
    ]);
  });

  test("子进程拿不到未放行的凭据，但保留白名单变量与适配器注入的 PISA_*", async () => {
    const dir = tempDir();
    // env 本身无法接收 omp 适配器追加的 -e/--mode 等参数，用包装脚本代替直接执行 env
    const printEnv = join(dir, "printenv.sh");
    writeFileSync(printEnv, "#!/bin/sh\nexec env\n");
    chmodSync(printEnv, 0o755);

    const saved = {
      token: process.env.PISA_TELEGRAM_TOKEN,
      gh: process.env.GH_TOKEN,
    };
    process.env.PISA_TELEGRAM_TOKEN = "SECRET";
    process.env.GH_TOKEN = "SECRET";
    try {
      const lines: string[] = [];
      const worker = new Worker(
        { adapter: "omp", command: printEnv, timeoutSec: 30, extraArgs: [], concurrency: 1 },
        join(dir, "state"),
      );
      const result = await worker.run(task, dir, (line) => lines.push(line), () => false);
      const out = lines.join("\n");

      expect(result.ok).toBe(true);
      expect(out).not.toContain("SECRET");
      expect(out).not.toMatch(/^PISA_TELEGRAM_TOKEN=/m);
      expect(out).not.toMatch(/^GH_TOKEN=/m);
      expect(out).toMatch(/^PATH=/m);
      expect(out).toMatch(/^HOME=/m);
      expect(out).toMatch(/^PISA_WORKDIR=/m);
      expect(out).toMatch(/^PISA_PROGRESS_FILE=/m);
    } finally {
      if (saved.token === undefined) delete process.env.PISA_TELEGRAM_TOKEN;
      else process.env.PISA_TELEGRAM_TOKEN = saved.token;
      if (saved.gh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved.gh;
    }
  });
});
