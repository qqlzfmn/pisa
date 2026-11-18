import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { editableConfig, parseEditable, saveEditableConfig } from "../src/config-edit";

const base = () => ({
  repos: [{ alias: "demo", path: "/srv/demo", baseBranch: "main" }],
  worker: { adapter: "omp", command: "omp", concurrency: 2, timeoutSec: 900 },
  schedules: [{ id: "nightly", cron: "0 3 * * *", prompt: "巡检" }],
});

function errorsOf(input: unknown): string[] {
  const parsed = parseEditable(input);
  return parsed.ok ? [] : parsed.errors;
}

describe("配置校验", () => {
  test("合法输入补齐默认值", () => {
    const parsed = parseEditable(base());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.repos).toEqual([{ alias: "demo", path: "/srv/demo", baseBranch: "main", remote: undefined }]);
    expect(parsed.config.schedules[0]).toEqual({ id: "nightly", cron: "0 3 * * *", prompt: "巡检", enabled: true });
  });

  test("拒绝空仓库、重复别名与非法别名", () => {
    expect(errorsOf({ ...base(), repos: [] })).toContain("repos 至少要有一个仓库");
    const dup = { ...base(), repos: [{ alias: "demo", path: "/a" }, { alias: "demo", path: "/b" }] };
    expect(errorsOf(dup).some((e) => e.includes("repos[1].alias") && e.includes("重复"))).toBe(true);
    const bad = { ...base(), repos: [{ alias: "有 空格", path: "/a" }] };
    expect(errorsOf(bad).some((e) => e.includes("repos[0].alias"))).toBe(true);
    const noPath = { ...base(), repos: [{ alias: "demo", path: "  " }] };
    expect(errorsOf(noPath).some((e) => e.includes("repos[0].path"))).toBe(true);
  });

  test("并发与超时的边界", () => {
    for (const concurrency of [0, 33, 1.5]) {
      const input = { ...base(), worker: { ...base().worker, concurrency } };
      expect(errorsOf(input).some((e) => e.includes("worker.concurrency"))).toBe(true);
    }
    for (const concurrency of [1, 32]) {
      expect(errorsOf({ ...base(), worker: { ...base().worker, concurrency } })).toHaveLength(0);
    }
    expect(errorsOf({ ...base(), worker: { ...base().worker, timeoutSec: 0 } }).some((e) => e.includes("timeoutSec"))).toBe(
      true,
    );
    expect(errorsOf({ ...base(), worker: { ...base().worker, adapter: "" } }).some((e) => e.includes("adapter"))).toBe(true);
  });

  test("定时任务校验 cron、重复 id 与未知仓库", () => {
    const badCron = { ...base(), schedules: [{ id: "x", cron: "0 3 * *", prompt: "p" }] };
    expect(errorsOf(badCron).some((e) => e.includes("schedules[0].cron"))).toBe(true);

    const dupId = { ...base(), schedules: [{ id: "a", cron: "* * * * *", prompt: "p" }, { id: "a", cron: "* * * * *", prompt: "q" }] };
    expect(errorsOf(dupId).some((e) => e.includes("schedules[1].id") && e.includes("重复"))).toBe(true);

    const unknownRepo = { ...base(), schedules: [{ id: "a", cron: "* * * * *", prompt: "p", repo: "nope" }] };
    expect(errorsOf(unknownRepo).some((e) => e.includes("schedules[0].repo") && e.includes("nope"))).toBe(true);

    const noPrompt = { ...base(), schedules: [{ id: "a", cron: "* * * * *", prompt: " " }] };
    expect(errorsOf(noPrompt).some((e) => e.includes("schedules[0].prompt"))).toBe(true);
  });

  test("非对象输入整体拒绝", () => {
    for (const input of [null, 42, [], { repos: "x" }]) {
      expect(parseEditable(input).ok).toBe(false);
    }
  });
});

describe("配置保存", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function seeded(): string {
    dir = mkdtempSync(join(tmpdir(), "pisa-config-edit-"));
    const path = join(dir, "pisa.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        trigger: "/pisa",
        retentionDays: 7,
        repos: [{ alias: "demo", path: "/srv/demo", baseBranch: "main" }],
        worker: { adapter: "omp", command: "omp", concurrency: 1, timeoutSec: 900, envAllow: ["PATH"] },
        schedules: [{ id: "nightly", cron: "0 3 * * *", prompt: "巡检" }],
      }),
    );
    return path;
  }

  test("只覆盖表单字段，其余原样保留", () => {
    const path = seeded();
    saveEditableConfig(path, {
      repos: [
        { alias: "demo", path: "/srv/demo", baseBranch: "main" },
        { alias: "lab", path: "/srv/lab" },
      ],
      worker: { adapter: "codex", command: "codex exec", concurrency: 4, timeoutSec: 600 },
      schedules: [{ id: "nightly", cron: "30 2 * * *", prompt: "巡检", enabled: false }],
    });

    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(raw.trigger).toBe("/pisa");
    expect(raw.retentionDays).toBe(7);
    // 表单没有的 worker 字段不能被抹掉
    expect(raw.worker).toEqual({ adapter: "codex", command: "codex exec", concurrency: 4, timeoutSec: 600, envAllow: ["PATH"] });
    expect((raw.repos as unknown[]).length).toBe(2);
    expect(raw.schedules).toEqual([{ id: "nightly", cron: "30 2 * * *", prompt: "巡检", enabled: false }]);
  });

  test("保存结果能被 loadConfig 读回", () => {
    const path = seeded();
    saveEditableConfig(path, {
      repos: [{ alias: "demo", path: "/srv/demo", baseBranch: "dev" }],
      worker: { adapter: "omp", command: "omp", concurrency: 8, timeoutSec: 120 },
      schedules: [{ id: "nightly", cron: "0 3 * * *", prompt: "巡检" }],
    });
    const cfg = loadConfig(path);
    expect(cfg.configPath).toBe(path);
    expect(cfg.repos[0]!.baseBranch).toBe("dev");
    expect(cfg.worker.concurrency).toBe(8);
    expect(cfg.worker.timeoutSec).toBe(120);
    expect(cfg.schedules?.[0]?.enabled ?? true).toBe(true);
  });

  test("editableConfig 投影只带表单字段", () => {
    const path = seeded();
    const view = editableConfig(loadConfig(path));
    expect(Object.keys(view).sort()).toEqual(["repos", "schedules", "worker"]);
    expect(Object.keys(view.worker).sort()).toEqual(["adapter", "command", "concurrency", "timeoutSec"]);
    expect(view.schedules).toEqual([{ id: "nightly", cron: "0 3 * * *", prompt: "巡检", enabled: true }]);
  });
});
