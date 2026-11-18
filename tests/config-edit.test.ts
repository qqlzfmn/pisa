import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editableConfig, saveConfigPatch, validateConfigPatch, type ConfigPatch } from "../src/config-edit";

interface RawConfig {
  repos?: unknown;
  worker?: unknown;
  schedules?: unknown;
  whitelist?: { users: string[]; repos: string[] };
  stateDir?: string;
  web?: unknown;
}

function readRaw(path: string): RawConfig {
  return JSON.parse(readFileSync(path, "utf8")) as RawConfig;
}

const valid: ConfigPatch = {
  repos: [{ alias: "demo", path: "/srv/demo", baseBranch: "main" }],
  worker: { adapter: "omp", command: "omp", concurrency: 3, timeoutSec: 1800 },
  schedules: [{ id: "nightly", cron: "0 3 * * *", prompt: "跑夜间回归", repo: "demo", enabled: true }],
};

describe("配置编辑校验", () => {
  test("合法补丁通过并去掉空字段", () => {
    const result = validateConfigPatch({
      repos: [{ alias: "demo", path: "/srv/demo", remote: "  ", baseBranch: "" }],
      worker: { adapter: " omp ", command: "omp", concurrency: 2, timeoutSec: 600 },
      schedules: [{ id: "n", cron: "*/5 * * * *", prompt: " 做事 ", repo: "", enabled: false }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.repos).toEqual([{ alias: "demo", path: "/srv/demo" }]);
    expect(result.patch.worker).toEqual({ adapter: "omp", command: "omp", concurrency: 2, timeoutSec: 600 });
    expect(result.patch.schedules).toEqual([{ id: "n", cron: "*/5 * * * *", prompt: "做事", enabled: false }]);
  });

  test("别名非法与重复都报错", () => {
    const result = validateConfigPatch({
      ...valid,
      repos: [
        { alias: "bad alias", path: "/a" },
        { alias: "dup", path: "/b" },
        { alias: "dup", path: "/c" },
        { alias: "", path: "" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("repos[0].alias 只能用字母、数字、下划线和短横线");
    expect(result.errors.join("\n")).toContain("repos[2].alias 重复：dup");
    expect(result.errors.join("\n")).toContain("repos[3].alias 不能为空");
    expect(result.errors.join("\n")).toContain("repos[3].path 不能为空");
  });

  test("并发与超时必须是范围内的整数", () => {
    const bad = (concurrency: unknown, timeoutSec: unknown) =>
      validateConfigPatch({ ...valid, worker: { ...valid.worker, concurrency, timeoutSec } });
    for (const value of [0, 65, 1.5, "2"]) {
      const result = bad(value, 600);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toContain("worker.concurrency");
    }
    for (const value of [0, 86_401, -1]) {
      const result = bad(2, value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toContain("worker.timeoutSec");
    }
    expect(bad(64, 86_400).ok).toBe(true);
    expect(bad(1, 1).ok).toBe(true);
  });

  test("adapter 与 command 不能为空", () => {
    const result = validateConfigPatch({ ...valid, worker: { ...valid.worker, adapter: " ", command: "" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("worker.adapter 不能为空");
    expect(result.errors.join("\n")).toContain("worker.command 不能为空");
  });

  test("cron 必须能解析，仓库引用必须在列表里", () => {
    const result = validateConfigPatch({
      ...valid,
      schedules: [
        { id: "a", cron: "not a cron", prompt: "x", enabled: true },
        { id: "b", cron: "0 3 * * *", prompt: "y", repo: "missing", enabled: true },
        { id: "b", cron: "0 3 * * *", prompt: "z", enabled: true },
        { id: "", cron: "", prompt: "", enabled: true },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.errors.join("\n");
    expect(text).toContain("schedules[0].cron 无法解析：not a cron");
    expect(text).toContain("schedules[1].repo 不在仓库列表里：missing");
    expect(text).toContain("schedules[2].id 重复：b");
    expect(text).toContain("schedules[3].id 不能为空");
    expect(text).toContain("schedules[3].cron 不能为空");
    expect(text).toContain("schedules[3].prompt 不能为空");
  });

  test("结构缺失按空数组处理并报错", () => {
    const result = validateConfigPatch({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("repos 必须是数组");
    expect(result.errors).toContain("schedules 必须是数组");
  });

  test("空仓库与空定时任务合法", () => {
    const result = validateConfigPatch({ repos: [], worker: valid.worker, schedules: [] });
    expect(result.ok).toBe(true);
  });
});

describe("配置投影与保存", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pisa-config-"));
    file = join(dir, "pisa.config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("文件不存在时投影回落默认值", () => {
    const view = editableConfig(file);
    expect(view.path).toBe(file);
    expect(view.repos).toEqual([]);
    expect(view.schedules).toEqual([]);
    expect(view.worker.adapter).toBe("omp");
    expect(view.worker.concurrency).toBe(2);
    expect(view.worker.envAllow.length).toBeGreaterThan(0);
    expect(view.schedulerConfigured).toBe(false);
  });

  test("投影读原始值，不锚定相对路径", () => {
    writeFileSync(
      file,
      JSON.stringify({
        repos: [{ alias: "demo", path: "../demo", remote: "upstream", baseBranch: "main" }],
        worker: { adapter: "codex", command: "codex", concurrency: 4, timeoutSec: 900, extraArgs: ["--yolo"], envAllow: ["PATH"] },
        schedules: [{ id: "n", cron: "0 3 * * *", prompt: "做事", repo: "demo", enabled: false }],
        scheduler: { chatId: "c1", userId: "u1" },
      }),
    );
    const view = editableConfig(file);
    expect(view.repos[0]!.path).toBe("../demo");
    expect(view.worker).toEqual({
      adapter: "codex",
      command: "codex",
      concurrency: 4,
      timeoutSec: 900,
      extraArgs: ["--yolo"],
      envAllow: ["PATH"],
    });
    expect(view.schedules).toEqual([{ id: "n", cron: "0 3 * * *", prompt: "做事", repo: "demo", enabled: false }]);
    expect(view.schedulerConfigured).toBe(true);
  });

  test("保存只覆盖可编辑键，保留其余配置与 worker 扩展字段", () => {
    const original = {
      stateDir: "/var/pisa",
      repos: [{ alias: "old", path: "/old" }],
      worker: { adapter: "omp", command: "omp", concurrency: 1, timeoutSec: 60, extraArgs: ["--x"], envAllow: ["PATH", "HOME"] },
      schedules: [],
      whitelist: { users: ["u1"], repos: ["old"] },
      web: { enabled: true, port: 8787 },
    };
    writeFileSync(file, JSON.stringify(original));

    saveConfigPatch(file, valid);

    const saved = readRaw(file);
    expect(saved.repos).toEqual([{ alias: "demo", path: "/srv/demo", baseBranch: "main" }]);
    expect(saved.worker).toEqual({
      adapter: "omp",
      command: "omp",
      concurrency: 3,
      timeoutSec: 1800,
      extraArgs: ["--x"],
      envAllow: ["PATH", "HOME"],
    });
    expect(saved.schedules).toEqual(valid.schedules);
    // 白名单原本非空：跟着新别名走，避免保存后仓库全部失联
    expect(saved.whitelist).toEqual({ users: ["u1"], repos: ["demo"] });
    expect(saved.stateDir).toBe("/var/pisa");
    expect(saved.web).toEqual({ enabled: true, port: 8787 });
  });

  test("保存保留 Web 不编辑的 capabilities", () => {
    const caps = { domains: ["example.com"], gui: true };
    writeFileSync(
      file,
      JSON.stringify({
        repos: [{ alias: "demo", path: "/srv/demo", capabilities: caps }],
        worker: { adapter: "omp", command: "omp", capabilities: caps },
      }),
    );

    saveConfigPatch(file, { ...valid, repos: [{ alias: "demo", path: "/srv/demo2", baseBranch: "dev" }] });

    const saved = readRaw(file) as {
      worker?: { capabilities?: unknown };
      repos?: Array<Record<string, unknown>>;
    };
    expect(saved.repos).toEqual([{ alias: "demo", path: "/srv/demo2", baseBranch: "dev", capabilities: caps }]);
    expect(saved.worker?.capabilities).toEqual(caps);
  });

  test("空白名单保持原样，保存配置不顺手放行仓库", () => {
    writeFileSync(file, JSON.stringify({ whitelist: { users: [], repos: [] } }));
    saveConfigPatch(file, valid);
    const saved = readRaw(file);
    expect(saved.whitelist).toEqual({ users: [], repos: [] });
    expect(editableConfig(file).repos).toEqual([{ alias: "demo", path: "/srv/demo", baseBranch: "main" }]);
  });

  test("保存后不留临时文件，且能再次读回同一份", () => {
    saveConfigPatch(file, valid);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const view = editableConfig(file);
    expect(view.repos).toEqual(valid.repos);
    expect(view.worker.concurrency).toBe(3);
    expect(view.schedules).toEqual(valid.schedules);
  });
});
