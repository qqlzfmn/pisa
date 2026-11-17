import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEGMENT_KEYS,
  diffLines,
  formatPromptDiff,
  formatPromptSummary,
  loadPrompts,
  renderPrompt,
} from "../src/prompts";
import { PROMPTS } from "./fixtures";

const vars = { id: "t_1", prompt: "修一下登录" };

const dirs: string[] = [];

/** 造一个临时提示词目录；team 为 undefined 时不写覆盖层 */
function fixture(builtin: unknown, team?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-prompts-"));
  dirs.push(dir);
  writeFileSync(join(dir, "builtin.json"), typeof builtin === "string" ? builtin : JSON.stringify(builtin));
  if (team !== undefined) {
    writeFileSync(join(dir, "team.json"), typeof team === "string" ? team : JSON.stringify(team));
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("提示词拼接", () => {
  test("段落顺序固定，任务与约束在最后", () => {
    const text = renderPrompt(PROMPTS, vars);
    const at = (marker: string) => text.indexOf(marker);
    expect(at("你是 pisa 的 Worker")).toBe(0);
    expect(at("## 任务")).toBeGreaterThan(at("你是 pisa 的 Worker"));
    expect(at("## 约束")).toBeGreaterThan(at("## 任务"));
    expect(at("修一下登录")).toBeGreaterThan(at("## 任务"));
  });

  test("恢复段与上下文段按条件出现", () => {
    expect(renderPrompt(PROMPTS, vars)).not.toContain("## 恢复执行");
    expect(renderPrompt(PROMPTS, vars)).not.toContain("上一轮上下文");

    const resumed = renderPrompt(PROMPTS, vars, { resume: true });
    expect(resumed.indexOf("## 恢复执行")).toBeLessThan(resumed.indexOf("## 任务"));

    const withContext = renderPrompt(PROMPTS, { ...vars, context: "上一轮改了 a.ts" });
    expect(withContext.indexOf("## 上一轮上下文")).toBeLessThan(withContext.indexOf("## 任务"));
    expect(withContext).toContain("上一轮改了 a.ts");

    expect(renderPrompt(PROMPTS, { ...vars, context: "  " })).toContain("上一轮上下文");
    expect(renderPrompt(PROMPTS, { ...vars, context: null })).not.toContain("上一轮上下文");
  });

  test("无覆盖时与原先写死的提示词逐字节一致", () => {
    const expected = [
      "你是 pisa 的 Worker，任务号 t_1。",
      "",
      "## 任务",
      "修一下登录",
      "",
      "## 约束",
      "- 只在当前工作目录内改动，不要访问父目录或仓库外路径",
      "- 不要执行 git commit / git push / git checkout 主分支 / git reset --hard",
      "- 不要删除未跟踪文件，不要强推",
      "- 有测试就跑测试；没有测试就说明你如何验证",
      "- 完成后用中文给出：改了什么、动了哪些文件、验证结果",
      "- 不要输出寒暄，直接给结论",
    ].join("\n");
    expect(renderPrompt(PROMPTS, vars)).toBe(expected);
  });
});

describe("分层覆盖", () => {
  const builtin = {
    version: 1,
    segments: { intro: "开场 {{id}}", resume: "恢复", context: "上下文 {{context}}", task: "任务 {{prompt}}", constraints: "约束" },
  };

  test("团队层只覆盖一段，其余回退内置并记录来源", () => {
    const dir = fixture(builtin, { version: 7, segments: { constraints: "必须跑 bun test" } });
    const set = loadPrompts(dir);
    expect(set.builtin.version).toBe(1);
    expect(set.team?.version).toBe(7);
    expect(set.segments.constraints).toBe("必须跑 bun test");
    expect(set.segments.task).toBe("任务 {{prompt}}");
    expect(set.sources.constraints).toBe("team");
    expect(set.sources.task).toBe("builtin");
    expect(renderPrompt(set, vars)).toBe("开场 t_1\n\n任务 修一下登录\n\n必须跑 bun test");
  });

  test("没有 team.json 时全部用内置", () => {
    const set = loadPrompts(fixture(builtin));
    expect(set.team).toBeNull();
    for (const key of SEGMENT_KEYS) expect(set.sources[key]).toBe("builtin");
  });

  test("版本号不同也能叠加，摘要展示两层版本", () => {
    const set = loadPrompts(fixture(builtin, { version: 3, segments: { intro: "团队开场 {{id}}" } }));
    const summary = formatPromptSummary(set, "/pisa");
    expect(summary).toContain("内置 v1");
    expect(summary).toContain("覆盖 v3");
    expect(summary).toContain("- intro · 覆盖");
    expect(summary).toContain("- constraints · 内置");
    expect(summary).toContain("/pisa prompts diff");
  });
});

describe("非法配置在装载时被拒绝", () => {
  const builtin = { version: 1, segments: { intro: "a", resume: "b", context: "c", task: "d", constraints: "e" } };

  test("未知顶层键", () => {
    const dir = fixture({ ...builtin, extra: true });
    expect(() => loadPrompts(dir)).toThrow("未知顶层键「extra」");
  });

  test("version 不是正整数", () => {
    expect(() => loadPrompts(fixture({ ...builtin, version: 0 }))).toThrow("version 必须是正整数");
    expect(() => loadPrompts(fixture({ ...builtin, version: "1" }))).toThrow("version 必须是正整数");
  });

  test("未知段落键", () => {
    const dir = fixture(builtin, { version: 1, segments: { tone: "温和" } });
    expect(() => loadPrompts(dir)).toThrow("未知段落「tone」");
  });

  test("内置层缺段落", () => {
    const segments = { intro: "a", resume: "b", context: "c", task: "d" };
    expect(() => loadPrompts(fixture({ version: 1, segments }))).toThrow("缺少段落 constraints");
  });

  test("段落为空或非字符串", () => {
    expect(() => loadPrompts(fixture(builtin, { version: 1, segments: { task: "  " } }))).toThrow("必须是非空字符串");
    expect(() => loadPrompts(fixture(builtin, { version: 1, segments: { task: 3 } }))).toThrow("必须是非空字符串");
  });

  test("未知占位符", () => {
    expect(() => loadPrompts(fixture(builtin, { version: 1, segments: { task: "任务 {{repo}}" } }))).toThrow(
      "未知占位符「{{repo}}」",
    );
  });

  test("覆盖层空的 segments 直接拒绝", () => {
    expect(() => loadPrompts(fixture(builtin, { version: 1, segments: {} }))).toThrow("segments 不能为空");
  });

  test("非法 JSON 与缺失内置文件", () => {
    expect(() => loadPrompts(fixture("{oops"))).toThrow("不是合法 JSON");
    const empty = mkdtempSync(join(tmpdir(), "pisa-prompts-"));
    dirs.push(empty);
    mkdirSync(empty, { recursive: true });
    expect(() => loadPrompts(empty)).toThrow("缺少内置提示词");
  });
});

describe("差异展示", () => {
  test("行级差异带 - / + 前缀", () => {
    expect(diffLines("a\nb", "a\nc")).toEqual([" a", "-b", "+c"]);
    expect(diffLines("a", "a")).toEqual([" a"]);
  });

  test("只展示被覆盖段落，未覆盖不出现", () => {
    const dir = fixture(
      { version: 2, segments: { intro: "开场 {{id}}", resume: "r", context: "c", task: "任务 {{prompt}}", constraints: "e" } },
      { version: 5, segments: { task: "任务：{{prompt}}" } },
    );
    const text = formatPromptDiff(loadPrompts(dir));
    expect(text).toContain("内置 v2 → 覆盖 v5");
    expect(text).toContain("## task");
    expect(text).not.toContain("## intro");
    expect(text).toContain("-任务 {{prompt}}");
    expect(text).toContain("+任务：{{prompt}}");
  });

  test("没有覆盖层时说明全部使用内置", () => {
    expect(formatPromptDiff(PROMPTS)).toBe(`没有覆盖层，全部使用内置 v${PROMPTS.builtin.version}。`);
  });
});
