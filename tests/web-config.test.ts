import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config";
import { configDraft, draftFromFile, sameDraft, validateDraft, writeConfigPatch, type ConfigDraft } from "../src/config-file";

const VALID: ConfigDraft = {
  repos: [
    { alias: "demo", path: "/work/demo", baseBranch: "main" },
    { alias: "ops", path: "/work/ops", remote: "upstream" },
  ],
  worker: { adapter: "omp", command: "omp run", concurrency: 2, timeoutSec: 1800, idleTimeoutSec: 900 },
  schedules: [
    { id: "daily", cron: "0 9 * * *", prompt: "每日巡检", repo: "demo", enabled: true },
    { id: "weekly", cron: "0 10 * * 1", prompt: "周报", enabled: false },
  ],
};

const clone = (): ConfigDraft => JSON.parse(JSON.stringify(VALID)) as ConfigDraft;

function errorsOf(mutate: (draft: Record<string, unknown>) => void): string[] {
  const draft = clone() as unknown as Record<string, unknown>;
  mutate(draft);
  const result = validateDraft(draft);
  return result.ok ? [] : result.errors;
}

describe("配置草稿校验", () => {
  test("合法草稿通过并规范化可选字段", () => {
    const result = validateDraft({
      repos: [{ alias: " demo ", path: " /work/demo ", remote: "", baseBranch: "" }],
      worker: { adapter: "omp", command: "omp run", concurrency: "3", timeoutSec: "600", idleTimeoutSec: "60" },
      schedules: [{ id: "a", cron: "0 9 * * *", prompt: "巡检", repo: "", enabled: undefined }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.repos).toEqual([{ alias: "demo", path: "/work/demo" }]);
    expect(result.draft.worker.concurrency).toBe(3);
    expect(result.draft.schedules).toEqual([{ id: "a", cron: "0 9 * * *", prompt: "巡检", enabled: true }]);
  });

  test("至少一个仓库", () => {
    expect(errorsOf((d) => (d.repos = []))).toContain("至少配置一个仓库");
  });

  test("别名必须合法且唯一", () => {
    const errors = errorsOf((d) => {
      (d.repos as Array<Record<string, unknown>>)[0]!.alias = "bad alias";
      (d.repos as Array<Record<string, unknown>>)[1]!.alias = "bad alias";
    });
    expect(errors.some((e) => e.includes("别名只能使用"))).toBe(true);
  });

  test("路径为空被拒绝", () => {
    expect(errorsOf((d) => ((d.repos as Array<Record<string, unknown>>)[0]!.path = " "))).toContain("仓库 demo 的路径为空");
  });

  test("并发与超时必须在整数区间内", () => {
    expect(errorsOf((d) => ((d.worker as Record<string, unknown>).concurrency = 0))).toEqual([
      "worker.concurrency 必须是 1–32 的整数",
    ]);
    expect(errorsOf((d) => ((d.worker as Record<string, unknown>).concurrency = 2.5))).toHaveLength(1);
    expect(errorsOf((d) => ((d.worker as Record<string, unknown>).timeoutSec = 0))).toEqual([
      "worker.timeoutSec 必须是 1–86400 的整数",
    ]);
    expect(errorsOf((d) => ((d.worker as Record<string, unknown>).idleTimeoutSec = "abc"))).toHaveLength(1);
  });

  test("worker 字段不能为空", () => {
    expect(errorsOf((d) => ((d.worker as Record<string, unknown>).adapter = ""))).toContain("worker.adapter 不能为空");
    expect(errorsOf((d) => ((d.worker as Record<string, unknown>).command = ""))).toContain("worker.command 不能为空");
  });

  test("定时任务的 cron、仓库与 id 都被校验", () => {
    expect(errorsOf((d) => ((d.schedules as Array<Record<string, unknown>>)[0]!.cron = "* * * *"))).toEqual([
      "定时任务 daily 的 cron 无法解析：* * * *",
    ]);
    expect(errorsOf((d) => ((d.schedules as Array<Record<string, unknown>>)[0]!.repo = "missing"))).toEqual([
      "定时任务 daily 指向未配置的仓库：missing",
    ]);
    expect(errorsOf((d) => ((d.schedules as Array<Record<string, unknown>>)[1]!.id = "daily"))).toContain("定时任务 id 重复：daily");
    expect(errorsOf((d) => ((d.schedules as Array<Record<string, unknown>>)[0]!.prompt = " "))).toContain(
      "定时任务 daily 的 prompt 为空",
    );
    expect(errorsOf((d) => ((d.schedules as Array<Record<string, unknown>>)[0]!.enabled = "yes"))).toContain(
      "定时任务 daily 的 enabled 必须是布尔值",
    );
  });

  test("非对象输入直接拒绝", () => {
    const result = validateDraft("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(["请求体缺少 draft"]);
  });
});

describe("配置文件回写", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function baseConfig(): Record<string, unknown> {
    return {
      trigger: "/pisa",
      whitelist: { users: ["u1"], repos: ["demo", "ops"] },
      repos: [{ alias: "demo", path: "/old/demo" }],
      worker: { adapter: "omp", command: "old", timeoutSec: 60, concurrency: 1, extraArgs: ["--fast"], envAllow: ["PATH"] },
      delivery: { push: true, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      stateDir: "/tmp/pisa-state",
    };
  }

  test("只覆盖受管字段，其它键与 worker 其余字段保留", () => {
    dir = mkdtempSync(join(tmpdir(), "pisa-cfg-"));
    const path = join(dir, "pisa.config.json");
    writeFileSync(path, JSON.stringify(baseConfig(), null, 2));

    writeConfigPatch(path, VALID);

    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(raw.trigger).toBe("/pisa");
    expect(raw.whitelist).toEqual({ users: ["u1"], repos: ["demo", "ops"] });
    expect(raw.delivery).toMatchObject({ push: true });
    expect(raw.worker).toMatchObject({
      adapter: "omp",
      command: "omp run",
      concurrency: 2,
      timeoutSec: 1800,
      idleTimeoutSec: 900,
      extraArgs: ["--fast"],
      envAllow: ["PATH"],
    });
    expect(raw.repos).toEqual(VALID.repos);
    expect(raw.schedules).toEqual(VALID.schedules);
    // 回写结果必须能被真实启动路径读回
    const cfg: Config = loadConfig(path);
    expect(cfg.repos.map((r) => r.alias)).toEqual(["demo", "ops"]);
    expect(cfg.worker.concurrency).toBe(2);
    expect(cfg.schedules?.map((s) => s.id)).toEqual(["daily", "weekly"]);
  });

  test("文件不存在时新建", () => {
    dir = mkdtempSync(join(tmpdir(), "pisa-cfg-"));
    const path = join(dir, "nested", "pisa.config.json");
    writeConfigPatch(path, VALID);
    expect(existsSync(path)).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).repos).toEqual(VALID.repos);
  });

  test("坏 JSON 拒绝覆盖，原文保留", () => {
    dir = mkdtempSync(join(tmpdir(), "pisa-cfg-"));
    const path = join(dir, "pisa.config.json");
    const broken = "{ not json";
    writeFileSync(path, broken);
    expect(() => writeConfigPatch(path, VALID)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(broken);
  });

  test("读取投影：文件值与生效值可比对", () => {
    dir = mkdtempSync(join(tmpdir(), "pisa-cfg-"));
    const path = join(dir, "pisa.config.json");
    writeFileSync(path, JSON.stringify(baseConfig(), null, 2));

    const active = configDraft(loadConfig(path));
    const same = draftFromFile(path, active);
    expect(same.error).toBeNull();
    expect(sameDraft(same.draft, active)).toBe(true);

    const changed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    changed.repos = VALID.repos;
    writeFileSync(path, JSON.stringify(changed, null, 2));
    const pending = draftFromFile(path, active);
    expect(sameDraft(pending.draft, active)).toBe(false);
  });

  test("文件解析失败时退回生效值并报错", () => {
    dir = mkdtempSync(join(tmpdir(), "pisa-cfg-"));
    const path = join(dir, "pisa.config.json");
    writeFileSync(path, "{ broken");
    const healthy = join(dir, "healthy.json");
    writeFileSync(healthy, JSON.stringify(baseConfig(), null, 2));
    const fallback = configDraft(loadConfig(healthy));
    const result = draftFromFile(path, fallback);
    expect(result.draft).toEqual(fallback);
    expect(result.error).toContain("配置文件无法解析");
  });
});
