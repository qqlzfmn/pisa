import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editableConfig, saveEditableConfig, validateEditable, type EditableConfig } from "../src/config-edit";
import type { Config } from "../src/config";

const ADAPTERS = ["omp", "codex"];

describe("配置编辑", () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pisa-config-edit-"));
    repo = join(root, "repo");
    mkdirSync(repo);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const rawConfig = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    repos: [{ alias: "demo", path: "repo", baseBranch: "main", remote: "", allowed: true }],
    worker: { adapter: "omp", command: "omp -p", timeoutSec: 60, concurrency: 2, extraArgs: ["--x"] },
    schedules: [],
    ...over,
  });

  test("editableConfig 从白名单映射 allowed", () => {
    const cfg: Config = {
      trigger: "/pisa",
      dmWithoutTrigger: true,
      whitelist: { users: ["u1"], repos: ["demo"] },
      repos: [
        { alias: "demo", path: repo, baseBranch: "main" },
        { alias: "spare", path: repo },
      ],
      worker: { adapter: "omp", command: "omp -p", timeoutSec: 60, extraArgs: [], concurrency: 2 },
      delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
      channels: { cli: true },
      stateDir: join(root, ".pisa"),
      schedules: [{ id: "nightly", cron: "0 3 * * *", prompt: "巡检" }],
    };
    const editable = editableConfig(cfg);
    expect(editable.repos).toEqual([
      { alias: "demo", path: repo, baseBranch: "main", remote: "", allowed: true },
      { alias: "spare", path: repo, baseBranch: "", remote: "", allowed: false },
    ]);
    expect(editable.worker).toEqual({ adapter: "omp", command: "omp -p", timeoutSec: 60, concurrency: 2, extraArgs: [] });
    expect(editable.schedules).toEqual([{ id: "nightly", cron: "0 3 * * *", prompt: "巡检" }]);
  });

  test("非法输入一次返回全部错误", () => {
    const result = validateEditable(
      {
        repos: [
          { alias: "demo", path: "missing", allowed: "yes" },
          { alias: "demo", path: "repo" },
          { alias: "bad alias", path: "repo" },
        ],
        worker: { adapter: "nope", command: "", timeoutSec: 0, concurrency: 33, extraArgs: "x" },
        schedules: [
          { id: "nightly", cron: "not cron", prompt: "", repo: "ghost" },
          { id: "nightly", cron: "* * * * *", prompt: "重复", enabled: "yes" },
          { id: "job one", cron: "* * * * *", prompt: "非法 id" },
        ],
      },
      root,
      ADAPTERS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = result.errors.join("\n");
    expect(message).toContain("alias 只能包含字母、数字、下划线与连字符");
    expect(message).toContain("path 不是已存在的目录");
    expect(message).toContain("allowed 必须是布尔值");
    expect(message).toContain("仓库别名重复");
    expect(message).toContain("worker.adapter 未知");
    expect(message).toContain("worker.command 不能为空");
    expect(message).toContain("worker.timeoutSec 必须在 1–86400 之间");
    expect(message).toContain("worker.concurrency 必须在 1–32 之间");
    expect(message).toContain("worker.extraArgs 必须是字符串数组");
    expect(message).toContain("id 只能包含字母、数字、下划线与连字符");
    expect(message).toContain("定时任务 id 重复");
    expect(message).toContain("cron 不是合法的 5 段 cron");
    expect(message).toContain("prompt 不能为空");
    expect(message).toContain("repo 未在 repos 中定义");
    expect(message).toContain("enabled 必须是布尔值");
  });

  test("合法输入裁剪空白并省略空字段", () => {
    const result = validateEditable(
      rawConfig({
        repos: [{ alias: " demo ", path: "repo", baseBranch: " main ", remote: " ", allowed: true }],
        schedules: [{ id: "nightly", cron: " 0 3 * * * ", prompt: " 巡检 ", repo: "", enabled: true }],
      }),
      root,
      ADAPTERS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repos).toEqual([{ alias: "demo", path: "repo", baseBranch: "main", remote: "", allowed: true }]);
    expect(result.value.worker.command).toBe("omp -p");
    expect(result.value.schedules).toEqual([{ id: "nightly", cron: "0 3 * * *", prompt: "巡检" }]);
  });

  test("保存保留未编辑键，写白名单并原子替换", () => {
    const path = join(root, "pisa.config.json");
    writeFileSync(
      path,
      JSON.stringify({ delivery: { pr: true }, worker: { idleTimeoutSec: 9 }, custom: { keep: 1 } }),
    );
    const value: EditableConfig = {
      repos: [
        { alias: "demo", path: "repo", baseBranch: "main", remote: "origin", allowed: true },
        { alias: "spare", path: "repo", baseBranch: "", remote: "", allowed: false },
      ],
      worker: { adapter: "codex", command: "codex exec", timeoutSec: 30, concurrency: 4, extraArgs: [] },
      schedules: [{ id: "nightly", cron: "0 3 * * *", prompt: "巡检", repo: "demo", enabled: false }],
    };
    saveEditableConfig(path, value);
    const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(saved.delivery).toEqual({ pr: true });
    expect(saved.custom).toEqual({ keep: 1 });
    expect(saved.worker).toEqual({
      idleTimeoutSec: 9,
      adapter: "codex",
      command: "codex exec",
      timeoutSec: 30,
      concurrency: 4,
      extraArgs: [],
    });
    expect(saved.repos).toEqual([
      { alias: "demo", path: "repo", baseBranch: "main", remote: "origin" },
      { alias: "spare", path: "repo" },
    ]);
    expect(saved.whitelist).toEqual({ repos: ["demo"] });
    expect(saved.schedules).toEqual([{ id: "nightly", cron: "0 3 * * *", prompt: "巡检", repo: "demo", enabled: false }]);
  });

  test("现有配置不是 JSON 对象时拒绝覆盖", () => {
    const path = join(root, "pisa.config.json");
    writeFileSync(path, "[]");
    expect(() =>
      saveEditableConfig(path, {
        repos: [],
        worker: { adapter: "omp", command: "omp", timeoutSec: 1, concurrency: 1, extraArgs: [] },
        schedules: [],
      }),
    ).toThrow("现有配置文件不是 JSON 对象");
    expect(readFileSync(path, "utf8")).toBe("[]");
  });
});
