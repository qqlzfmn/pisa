import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, configForEdit, patchKeys, readRawConfig, validateConfig, writeConfig } from "../src/web/config-edit";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-web-config-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const base = {
  trigger: "/pisa",
  repos: [{ alias: "demo", path: "/tmp/demo", baseBranch: "main" }],
  worker: { adapter: "omp", command: "omp", timeoutSec: 3600, extraArgs: [], concurrency: 2 },
  scheduler: { chatId: "c1", userId: "u1" },
};

describe("validateConfig", () => {
  test("合法配置没有错误", () => {
    expect(validateConfig(base)).toEqual([]);
  });

  test("别名重复", () => {
    const errors = validateConfig({
      ...base,
      repos: [
        { alias: "demo", path: "/tmp/a" },
        { alias: "demo", path: "/tmp/b" },
      ],
    });
    expect(errors).toContain("仓库别名重复：demo");
  });

  test("路径为空与别名非法字符", () => {
    const errors = validateConfig({ ...base, repos: [{ alias: "de mo", path: "  " }] });
    expect(errors.some((e) => e.includes("alias"))).toBe(true);
    expect(errors).toContain("repos[0].path 不能为空");
  });

  test("并发与超时必须是区间内的整数", () => {
    const errors = validateConfig({ ...base, worker: { ...base.worker, concurrency: 0, timeoutSec: 1.5 } });
    expect(errors).toContain("worker.concurrency 必须是 1–64 的整数");
    expect(errors).toContain("worker.timeoutSec 必须是 1–86400 的整数");
    expect(validateConfig({ ...base, worker: { ...base.worker, concurrency: 65 } })).toContain(
      "worker.concurrency 必须是 1–64 的整数",
    );
  });

  test("cron 必须是 5 段", () => {
    const errors = validateConfig({
      ...base,
      schedules: [{ id: "daily", cron: "0 9 * *", prompt: "检查依赖" }],
    });
    expect(errors).toContain("schedules[0].cron 不是合法的 5 段 cron");
  });

  test("定时任务引用未定义的仓库", () => {
    const errors = validateConfig({
      ...base,
      schedules: [{ id: "daily", cron: "0 9 * * 1-5", prompt: "检查依赖", repo: "nope" }],
    });
    expect(errors).toContain("schedules[0].repo 未在 repos 中定义：nope");
  });

  test("有定时任务时必须配置 scheduler 身份", () => {
    const errors = validateConfig({
      trigger: "/pisa",
      repos: base.repos,
      worker: base.worker,
      schedules: [{ id: "daily", cron: "0 9 * * 1-5", prompt: "检查依赖" }],
    });
    expect(errors).toContain("配置了 schedules 时必须填写 scheduler.chatId");
    expect(errors).toContain("配置了 schedules 时必须填写 scheduler.userId");
  });

  test("worker 段不是对象", () => {
    expect(validateConfig({ ...base, worker: 3 })).toEqual(["worker 必须是对象"]);
  });
});

describe("patchKeys / applyPatch", () => {
  test("只允许 repos、worker、schedules", () => {
    expect(patchKeys({ trigger: "/x" })).toEqual(["不支持的配置段：trigger"]);
    expect(patchKeys({ repos: {} })).toEqual(["repos 必须是数组"]);
    expect(patchKeys({ worker: 3 })).toEqual(["worker 必须是对象"]);
    expect(patchKeys({ repos: [], worker: {}, schedules: [] })).toEqual([]);
  });

  test("worker 部分更新，其余段整体替换，未提及的键保留", () => {
    const raw = { trigger: "/x", extra: 1, worker: { adapter: "omp", command: "omp", concurrency: 2 } };
    const next = applyPatch(raw, { worker: { concurrency: 5 }, repos: [{ alias: "demo", path: "/tmp/demo" }] });
    expect(next.trigger).toBe("/x");
    expect(next.extra).toBe(1);
    expect(next.worker).toEqual({ adapter: "omp", command: "omp", concurrency: 5 });
    expect(next.repos).toEqual([{ alias: "demo", path: "/tmp/demo" }]);
  });

  test("scheduler 也是部分更新", () => {
    const raw = { scheduler: { chatId: "c1", userId: "u1" } };
    expect(applyPatch(raw, { scheduler: { userId: "u2" } })).toEqual({ scheduler: { chatId: "c1", userId: "u2" } });
    expect(patchKeys({ scheduler: "c1" })).toEqual(["scheduler 必须是对象"]);
  });

  test("只改 worker 时 repos 原样保留", () => {
    const raw = { repos: [{ alias: "a", path: "/a" }], worker: { adapter: "omp" } };
    expect(applyPatch(raw, { worker: { concurrency: 3 } }).repos).toEqual(raw.repos);
  });
});

describe("readRawConfig / writeConfig", () => {
  test("文件不存在返回空对象", () => {
    expect(readRawConfig(join(tempDir(), "missing.json"))).toEqual({});
  });

  test("顶层不是对象时报错", () => {
    const path = join(tempDir(), "pisa.config.json");
    writeFileSync(path, "[]");
    expect(() => readRawConfig(path)).toThrow("配置文件顶层必须是 JSON 对象");
  });

  test("写入 2 空格缩进且不留下临时文件", () => {
    const dir = tempDir();
    const path = join(dir, "pisa.config.json");
    writeConfig(path, { ...base, web: { enabled: true, port: 9000 } });
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify({ ...base, web: { enabled: true, port: 9000 } }, null, 2)}\n`);
    expect(readdirSync(dir)).toEqual(["pisa.config.json"]);
  });
});

describe("configForEdit", () => {
  test("缺省 schedules 补成空数组", () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, base);
    expect(configForEdit(cfg)).toEqual({
      repos: base.repos,
      worker: cfg.worker,
      scheduler: base.scheduler,
      schedules: [],
    });
  });
});
