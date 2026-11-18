import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { loadConfig } from "../src/config";
import { healthReport } from "../src/health";
import { Store } from "../src/store";
import { sh } from "../src/git";

let root: string;
let repo: string;
let stateDir: string;
let cfgPath: string;

interface Result {
  code: number;
  out: string;
  err: string;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pisa-ops-"));
  stateDir = join(root, ".pisa");
  mkdirSync(stateDir, { recursive: true });
  cfgPath = join(root, "pisa.config.json");
  repo = join(root, "repo");
  mkdirSync(repo);
  sh(["git", "init", "-q", "-b", "main"], repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  sh(["git", "-C", repo, "add", "-A"]);
  sh(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  writeConfig();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(over: Record<string, unknown> = {}): void {
  writeFileSync(
    cfgPath,
    JSON.stringify({
      repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
      whitelist: { users: ["tester"], repos: ["demo"] },
      channels: { cli: true },
      stateDir: ".pisa",
      worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
      ...over,
    }),
  );
}

function openStore(): Store {
  return new Store(join(stateDir, "pisa.db"));
}

function beatAt(at = Date.now()): void {
  const store = openStore();
  store.beat(at);
  store.close();
}

/** 造一条重试耗尽的 outbox 行：健康检查里对应「部件错误」 */
function failEffect(): void {
  const store = openStore();
  const at = Date.now();
  const key = `issue:${at}`;
  store.enqueueEffect({ kind: "comment", key, taskId: null, payload: "{}", at });
  store.failEffect("comment", key, "boom", { nextAt: at, terminal: true }, at);
  store.close();
}

async function cli(...argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...argv, "--config", cfgPath], { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("pisa status 健康退出码", () => {
  test("0 正常 / 1 需重启 / 2 部件错误 / 3 待配置，取最严重的一个", async () => {
    beatAt();
    const ok = await cli("status");
    expect(ok.code).toBe(0);
    expect(ok.out).not.toContain("健康：");

    const json = JSON.parse((await cli("status", "--json")).out) as { health: { exit: number; label: string; issues: unknown[] } };
    expect(json.health).toEqual({ exit: 0, label: "正常", issues: [] });

    beatAt(Date.now() - 60_000);
    const down = await cli("status");
    expect(down.code).toBe(1);
    expect(down.out).toContain("健康：需重启");
    expect(down.out).toContain("心跳已过期");

    const store = openStore();
    store.deleteMeta("heartbeat");
    store.close();
    const never = await cli("status");
    expect(never.code).toBe(1);
    expect(never.out).toContain("从未上报心跳");

    beatAt();
    failEffect();
    const broken = await cli("status");
    expect(broken.code).toBe(2);
    expect(broken.out).toContain("健康：部件错误");
    expect(broken.out).toContain("1 条外部动作重试耗尽");

    const plain = join(root, "plain");
    mkdirSync(plain);
    writeConfig({ repos: [{ alias: "demo", path: plain }] });
    const unconfigured = await cli("status");
    expect(unconfigured.code).toBe(3);
    expect(unconfigured.out).toContain("健康：待配置");
    expect(unconfigured.out).toContain("不是 git 仓库");
  });

  test("启用通道缺 token、定时任务缺身份都算待配置", () => {
    writeConfig({
      channels: { cli: true, telegram: { enabled: true, tokenEnv: "PISA_TELEGRAM_TOKEN" } },
      schedules: [{ id: "morning", cron: "0 9 * * *", prompt: "x" }],
    });
    const store = openStore();
    beatAt();
    const report = healthReport(loadConfig(cfgPath), store, { token: () => null });
    store.close();
    expect(report.exit).toBe(3);
    const keys = report.issues.map((issue) => issue.key);
    expect(keys).toContain("config:telegram-token");
    expect(keys).toContain("config:scheduler");
  });

  test("纯 CLI 部署不因白名单为空报待配置", () => {
    writeConfig({ whitelist: { users: [], repos: [] }, channels: { cli: true } });
    const store = openStore();
    store.beat();
    const report = healthReport(loadConfig(cfgPath), store, { token: () => null });
    store.close();
    expect(report.exit).toBe(0);
  });
});

describe("pisa patrol 每小时巡检", () => {
  test("同一问题只提醒一次，恢复清零，问题变化再提醒", async () => {
    const first = await cli("patrol");
    expect(first.code).toBe(1);
    expect(first.out).toContain("pisa 巡检：需重启（退出码 1）");
    expect(first.out).toContain("从未上报心跳");

    const repeat = await cli("patrol");
    expect(repeat.code).toBe(1);
    expect(repeat.out).toBe("");

    beatAt();
    const healthy = await cli("patrol");
    expect(healthy.code).toBe(0);
    expect(healthy.out).toBe("");

    const store = openStore();
    store.deleteMeta("heartbeat");
    store.close();
    const back = await cli("patrol");
    expect(back.code).toBe(1);
    expect(back.out).toContain("从未上报心跳");

    beatAt();
    failEffect();
    const changed = await cli("patrol");
    expect(changed.code).toBe(2);
    expect(changed.out).toContain("pisa 巡检：部件错误（退出码 2）");
    expect(changed.out).toContain("外部动作重试耗尽");

    const changedRepeat = await cli("patrol");
    expect(changedRepeat.code).toBe(2);
    expect(changedRepeat.out).toBe("");
  });
});
