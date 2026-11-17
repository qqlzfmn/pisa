import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store";
import type { Config } from "../src/config";
import {
  alertStatePath,
  formatReport,
  heartbeatPath,
  inspect,
  shouldSpeak,
  startHeartbeat,
  type HealthReport,
} from "../src/health";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pisa-health-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cfg(over: Partial<Config> = {}): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: join(dir, "repo"), baseBranch: "main" }],
    worker: { adapter: "omp", command: process.execPath, timeoutSec: 60, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir: join(dir, "state"),
    ...over,
  };
}

function configFile(): string {
  const p = join(dir, "pisa.config.json");
  writeFileSync(p, "{}");
  return p;
}

function repo(): string {
  const p = join(dir, "repo");
  mkdirSync(p, { recursive: true });
  return p;
}

/** 写一份新鲜心跳 */
function beat(stateDir = join(dir, "state")): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "heartbeat"), "ok");
}

/** 健康基线：仓库存在、心跳新鲜、任务库可读 */
function healthy(over: Partial<Config> = {}): { c: Config; file: string } {
  const c = cfg(over);
  mkdirSync(c.repos[0]!.path, { recursive: true });
  beat(c.stateDir);
  new Store(join(c.stateDir, "pisa.db")).close();
  return { c, file: configFile() };
}

describe("inspect 四种退出码", () => {
  test("缺配置文件 → 3 待配置", () => {
    const r = inspect({ cfg: cfg(), configFile: join(dir, "missing.json") });
    expect(r.code).toBe(3);
    expect(r.problems.map((p) => p.key)).toContain("config-missing");
  });

  test("没有仓库 → 3", () => {
    const r = inspect({ cfg: cfg({ repos: [] }), configFile: configFile() });
    expect(r.code).toBe(3);
    expect(r.problems.map((p) => p.key)).toContain("repos-empty");
  });

  test("仓库路径不存在 → 3", () => {
    const r = inspect({ cfg: cfg(), configFile: configFile() });
    expect(r.code).toBe(3);
    expect(r.problems.map((p) => p.key)).toContain("repo-missing:demo");
  });

  test("没有启用任何通道 → 3", () => {
    repo();
    const r = inspect({ cfg: cfg({ channels: {} }), configFile: configFile() });
    expect(r.code).toBe(3);
    expect(r.problems.map((p) => p.key)).toContain("channel-none");
  });

  test("配置无法解析 → 3，只报解析错误", () => {
    repo();
    const r = inspect({ cfg: cfg(), configFile: configFile(), configError: "Expected '}'" });
    expect(r.code).toBe(3);
    expect(r.problems.map((p) => p.key)).toEqual(["config-invalid"]);
    expect(r.problems[0]!.message).toContain("无法解析");
  });

  test("worker 命令不存在 → 2 部件错误", () => {
    repo();
    const c = cfg({ worker: { adapter: "omp", command: "pisa-no-such-worker", timeoutSec: 60, extraArgs: [], concurrency: 1 } });
    const r = inspect({ cfg: c, configFile: configFile() });
    expect(r.code).toBe(2);
    expect(r.problems.map((p) => p.key)).toContain("worker-missing:pisa-no-such-worker");
  });

  test("通道凭证缺失 → 2", () => {
    repo();
    const c = cfg({ channels: { telegram: { enabled: true, tokenEnv: "PISA_TEST_MISSING_TOKEN" } } });
    delete process.env.PISA_TEST_MISSING_TOKEN;
    const r = inspect({ cfg: c, configFile: configFile() });
    expect(r.code).toBe(2);
    expect(r.problems.map((p) => p.key)).toContain("telegram-token");
  });

  test("任务库损坏 → 2", () => {
    const c = cfg();
    repo();
    beat(c.stateDir);
    writeFileSync(join(c.stateDir, "pisa.db"), "not a database");
    const r = inspect({ cfg: c, configFile: configFile() });
    expect(r.code).toBe(2);
    expect(r.problems.map((p) => p.key)).toContain("db-unreadable");
  });

  test("心跳正常但任务库不存在 → 2", () => {
    const c = cfg();
    repo();
    beat(c.stateDir);
    const r = inspect({ cfg: c, configFile: configFile() });
    expect(r.code).toBe(2);
    expect(r.problems.map((p) => p.key)).toContain("db-missing");
  });

  test("没有心跳 → 1 需重启", () => {
    repo();
    const r = inspect({ cfg: cfg(), configFile: configFile() });
    expect(r.code).toBe(1);
    expect(r.problems.map((p) => p.key)).toContain("heartbeat-stale");
  });

  test("心跳过期 → 1", () => {
    const { c, file } = healthy();
    const old = Math.floor(Date.now() / 1000) - 600;
    utimesSync(heartbeatPath(c.stateDir), old, old);
    const r = inspect({ cfg: c, configFile: file });
    expect(r.code).toBe(1);
    expect(r.problems[0]!.key).toBe("heartbeat-stale");
    expect(r.problems[0]!.message).toContain("阈值 180s");
  });

  test("一切正常 → 0", () => {
    const { c, file } = healthy();
    const r = inspect({ cfg: c, configFile: file });
    expect(r.code).toBe(0);
    expect(r.problems).toEqual([]);
  });

  test("报告标明退出码含义", () => {
    expect(formatReport({ code: 0, problems: [], checkedAt: 0 })).toContain("正常");
    expect(formatReport({ code: 2, problems: [{ key: "k", message: "坏了" }], checkedAt: 0 })).toContain("部件错误");
  });
});

describe("心跳", () => {
  test("启动即写一次，可停止", () => {
    const stateDir = join(dir, "state");
    const stop = startHeartbeat(stateDir);
    expect(existsSync(heartbeatPath(stateDir))).toBe(true);
    stop();
  });
});

describe("巡检去重", () => {
  const broken: HealthReport = { code: 2, problems: [{ key: "worker-missing:x", message: "找不到 worker 命令 x" }], checkedAt: 0 };

  test("同一问题只说一次，明细变化不算新问题", () => {
    expect(shouldSpeak(dir, broken)).toBe(true);
    expect(existsSync(alertStatePath(dir))).toBe(true);
    expect(shouldSpeak(dir, broken)).toBe(false);
    expect(shouldSpeak(dir, { ...broken, problems: [{ key: "worker-missing:x", message: "换了措辞" }] })).toBe(false);
  });

  test("换了问题会重新说", () => {
    expect(shouldSpeak(dir, broken)).toBe(true);
    expect(shouldSpeak(dir, { code: 1, problems: [{ key: "heartbeat-stale", message: "心跳过期" }], checkedAt: 0 })).toBe(true);
  });

  test("恢复后清零，再坏重新说", () => {
    expect(shouldSpeak(dir, broken)).toBe(true);
    expect(shouldSpeak(dir, { code: 0, problems: [], checkedAt: 0 })).toBe(false);
    expect(existsSync(alertStatePath(dir))).toBe(false);
    expect(shouldSpeak(dir, broken)).toBe(true);
  });

  test("状态文件损坏时重新通知", () => {
    writeFileSync(alertStatePath(dir), "oops");
    expect(shouldSpeak(dir, broken)).toBe(true);
    expect(JSON.parse(readFileSync(alertStatePath(dir), "utf8")).signature).toBeString();
  });
});

describe("pisa status 命令", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");

  function run(args: string[], cwd = dir, env: Record<string, string> = {}) {
    const res = Bun.spawnSync({
      cmd: [process.execPath, cli, ...args],
      cwd,
      env: { ...process.env, PISA_CONFIG: join(cwd, "pisa.config.json"), PISA_STATE_DIR: join(cwd, "state"), ...env },
    });
    return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() };
  }

  function writeCfg(cwd: string, c: Config): void {
    writeFileSync(join(cwd, "pisa.config.json"), JSON.stringify({ repos: c.repos, worker: c.worker, channels: c.channels }));
  }

  test("缺配置 → 3", () => {
    const r = run(["status"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("待配置");
  });

  test("配置无法解析 → 3，不崩溃", () => {
    writeFileSync(join(dir, "pisa.config.json"), "{bad json");
    const r = run(["status"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("配置文件无法解析");
    expect(r.err).toBe("");
  });

  test("部件错误 → 2", () => {
    const c = cfg({ worker: { adapter: "omp", command: "pisa-no-such-worker", timeoutSec: 60, extraArgs: [], concurrency: 1 } });
    mkdirSync(c.repos[0]!.path, { recursive: true });
    writeCfg(dir, c);
    const r = run(["status"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("找不到 worker 命令");
  });

  test("没有心跳 → 1", () => {
    const c = cfg();
    mkdirSync(c.repos[0]!.path, { recursive: true });
    writeCfg(dir, c);
    const r = run(["status"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("需重启");
  });

  test("全部正常 → 0；--alert 静默", () => {
    const c = cfg();
    mkdirSync(c.repos[0]!.path, { recursive: true });
    writeCfg(dir, c);
    beat(join(dir, "state"));
    new Store(join(dir, "state", "pisa.db")).close();

    const plain = run(["status"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("正常");

    const alert = run(["status", "--alert"]);
    expect(alert.code).toBe(0);
    expect(alert.out).toBe("");
  });

  test("--alert 同一问题只输出一次，恢复后重新输出", () => {
    const c = cfg({ worker: { adapter: "omp", command: "pisa-no-such-worker", timeoutSec: 60, extraArgs: [], concurrency: 1 } });
    mkdirSync(c.repos[0]!.path, { recursive: true });
    writeCfg(dir, c);

    const first = run(["status", "--alert"]);
    expect(first.code).toBe(2);
    expect(first.out).toContain("部件错误");

    const second = run(["status", "--alert"]);
    expect(second.code).toBe(2);
    expect(second.out).toBe("");

    // 修好：换回可用的 worker 命令、补心跳与任务库
    writeCfg(dir, cfg());
    beat(join(dir, "state"));
    new Store(join(dir, "state", "pisa.db")).close();
    const recovered = run(["status", "--alert"]);
    expect(recovered.code).toBe(0);
    expect(recovered.out).toBe("");
    expect(existsSync(join(dir, "state", "ops-alert.json"))).toBe(false);

    // 再坏一次，应该重新说话
    writeCfg(dir, c);
    const again = run(["status", "--alert"]);
    expect(again.code).toBe(2);
    expect(again.out).toContain("部件错误");
  });

  test("未知参数 → 64", () => {
    expect(run(["bogus"]).code).toBe(64);
    expect(run(["status", "--nope"]).code).toBe(64);
  });
});
