import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, DEFAULT_ENV_ALLOW, loadConfig } from "../src/config";
import { capabilitySource } from "../src/capabilities";
import { Worker, workerEnv } from "../src/worker";
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
    expect(cfg.worker.verifyTimeoutSec).toBe(600);
  });
});

/** 用包装脚本代替 omp：打印快照，并按需追加一条 guard 拦截事件 */
function fakeAgent(dir: string, marker = ""): string {
  const path = join(dir, "agent.sh");
  writeFileSync(path, `#!/bin/sh\n${marker}\nexec env\n`);
  chmodSync(path, 0o755);
  return path;
}

function withSecret(name: string, value: string, fn: () => Promise<void>): Promise<void> {
  const saved = process.env[name];
  process.env[name] = value;
  return fn().finally(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
}

describe("Worker.run", () => {
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
      expect(out).toMatch(/^PISA_CAPABILITIES=.*"gui":false/m);
    } finally {
      if (saved.token === undefined) delete process.env.PISA_TELEGRAM_TOKEN;
      else process.env.PISA_TELEGRAM_TOKEN = saved.token;
      if (saved.gh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved.gh;
    }
  });

  test("默认能力清单不含密钥，审计随结果返回", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const worker = new Worker(
      { adapter: "omp", command: fakeAgent(dir), timeoutSec: 30, extraArgs: [], concurrency: 1 },
      join(dir, "state"),
    );
    await withSecret("GH_TOKEN", "SECRET", async () => {
      const result = await worker.run(task, dir, (line) => lines.push(line), () => false);
      const out = lines.join("\n");
      expect(out).not.toMatch(/^GH_TOKEN=/m);
      expect(out).toMatch(/"env":\["PATH"/);
      expect(out).not.toContain('"GH_TOKEN"');
      expect(result.audit?.capabilities.repo).toBe("demo");
      expect(result.audit?.capabilities.gui).toBe(false);
      expect(result.audit?.violations).toEqual([]);
    });
  });

  test("仓库声明的密钥进入子进程，并写进清单", async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const capSource = capabilitySource({
      repos: [{ alias: "demo", path: dir, capabilities: { env: ["GH_TOKEN"], domains: ["api.github.com"] } }],
    });
    const worker = new Worker(
      { adapter: "omp", command: fakeAgent(dir), timeoutSec: 30, extraArgs: [], concurrency: 1 },
      join(dir, "state"),
      capSource,
    );
    await withSecret("GH_TOKEN", "SECRET", async () => {
      const result = await worker.run(task, dir, (line) => lines.push(line), () => false);
      const out = lines.join("\n");
      expect(out).toMatch(/^GH_TOKEN=SECRET$/m);
      expect(result.audit?.capabilities.env).toContain("GH_TOKEN");
      expect(result.audit?.capabilities.domains).toEqual(["api.github.com"]);
    });
  });

  test("守卫拦截进入审计", async () => {
    const dir = tempDir();
    const event = JSON.stringify({ type: "blocked", tool: "bash", detail: "git push", reason: "禁止 git push" });
    const worker = new Worker(
      {
        adapter: "omp",
        command: fakeAgent(dir, `printf '%s\\n' '${event}' >> "$PISA_PROGRESS_FILE"`),
        timeoutSec: 30,
        extraArgs: [],
        concurrency: 1,
      },
      join(dir, "state"),
    );
    const result = await worker.run(task, dir, () => {}, () => false);
    expect(result.audit?.violations).toEqual([{ tool: "bash", detail: "git push", reason: "禁止 git push" }]);
  });
});
