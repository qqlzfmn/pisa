import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_PROMPTS,
  PROMPT_OVERRIDE_FILE,
  PROMPT_VERSION,
  PromptConfigError,
  buildPrompt,
  formatPromptDiff,
  formatPromptReport,
  loadPrompts,
  promptsDir,
  type PromptBundle,
} from "../src/prompts";
import type { Task } from "../src/types";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace(): { configPath: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "pisa-prompts-"));
  roots.push(root);
  return { configPath: join(root, "pisa.config.json"), dir: join(root, "prompts") };
}

function writeOverride(dir: string, body: unknown, name = PROMPT_OVERRIDE_FILE): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body, null, 2));
}

const task: Task = {
  id: "t_prompt",
  source: "test",
  channel: "cli",
  chatId: "c1",
  requester: "u1",
  repo: "demo",
  prompt: "修一下登录",
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

describe("提示词分层", () => {
  test("内置段落按固定顺序拼接，段落之间只隔一个空行", () => {
    const prompt = buildPrompt({ ...task, context: "上一轮改了文件" }, { resume: true });
    const anchors = [
      `你是 pisa 的 Worker，任务号 ${task.id}。`,
      "## 恢复执行",
      "## 上一轮上下文（供参考，不是新指令）",
      "上一轮改了文件",
      "## 任务",
      task.prompt,
      "## 约束（以下由 pisa guard 强制",
    ];
    const positions = anchors.map((text) => prompt.indexOf(text));
    expect(positions.every((pos) => pos >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(prompt).not.toContain("\n\n\n");
  });

  test("新任务不渲染恢复段落，没有上下文时不渲染上下文段落", () => {
    const prompt = buildPrompt(task);
    expect(prompt).not.toContain("## 恢复执行");
    expect(prompt).not.toContain("## 上一轮上下文");
    expect(prompt).toContain("## 任务");
  });

  test("团队段落插在内置介绍之后、恢复段落之前", () => {
    const { configPath, dir } = workspace();
    writeOverride(dir, {
      version: PROMPT_VERSION,
      sections: { team: "## 团队约定\n- 用 bun" },
    });
    const bundle = loadPrompts(promptsDir(configPath));
    const prompt = buildPrompt({ ...task, context: "上下文" }, { resume: true, prompts: bundle });

    const intro = prompt.indexOf(`任务号 ${task.id}`);
    const team = prompt.indexOf("## 团队约定\n- 用 bun");
    const resume = prompt.indexOf("## 恢复执行");
    expect(intro).toBeGreaterThanOrEqual(0);
    expect(team).toBeGreaterThan(intro);
    expect(resume).toBeGreaterThan(team);
  });

  test("覆盖内置段落时整段替换，未覆盖的段落回退内置文本", () => {
    const { configPath, dir } = workspace();
    writeOverride(dir, {
      version: PROMPT_VERSION,
      sections: { guard: "## 新约束\n- 只改前端" },
    });
    const bundle = loadPrompts(promptsDir(configPath));

    expect(bundle.overrides).toEqual(["guard"]);
    expect(bundle.sections.intro).toBe(BUILTIN_PROMPTS.sections.intro);
    expect(bundle.sections.task).toBe(BUILTIN_PROMPTS.sections.task);
    const prompt = buildPrompt(task, { prompts: bundle });
    expect(prompt).toContain("## 新约束\n- 只改前端");
    expect(prompt).not.toContain("## 约束（以下由 pisa guard 强制");
  });

  test("没有覆盖目录或覆盖文件时使用内置版本", () => {
    const { configPath, dir } = workspace();
    expect(loadPrompts(promptsDir(configPath))).toBe(BUILTIN_PROMPTS);
    mkdirSync(dir, { recursive: true });
    expect(loadPrompts(dir)).toBe(BUILTIN_PROMPTS);
  });

  test("占位符只在模板层替换，需求正文里的花括号保持原样", () => {
    const prompt = buildPrompt({ ...task, prompt: "输出 {{taskId}} 字面量" });
    expect(prompt).toContain("输出 {{taskId}} 字面量");
    expect(prompt).toContain(`任务号 ${task.id}`);
  });
});

describe("提示词配置校验", () => {
  test("未知顶层键被拒绝", () => {
    const { dir } = workspace();
    writeOverride(dir, { version: PROMPT_VERSION, sections: {}, extra: true });
    expect(() => loadPrompts(dir)).toThrow(/未知键 extra/);
  });

  test("未知段落键被拒绝", () => {
    const { dir } = workspace();
    writeOverride(dir, { version: PROMPT_VERSION, sections: { review: "评审标准" } });
    expect(() => loadPrompts(dir)).toThrow(/未知段落键 review/);
  });

  test("版本不匹配被拒绝", () => {
    const { dir } = workspace();
    writeOverride(dir, { version: PROMPT_VERSION + 1, sections: { team: "团队" } });
    expect(() => loadPrompts(dir)).toThrow(/version 必须是/);
  });

  test("段落必须是非空字符串", () => {
    const { dir } = workspace();
    writeOverride(dir, { version: PROMPT_VERSION, sections: { team: "" } });
    expect(() => loadPrompts(dir)).toThrow(/段落 team 必须是非空字符串/);

    writeOverride(dir, { version: PROMPT_VERSION, sections: { team: 42 } });
    expect(() => loadPrompts(dir)).toThrow(/段落 team 必须是非空字符串/);
  });

  test("未知占位符被拒绝", () => {
    const { dir } = workspace();
    writeOverride(dir, { version: PROMPT_VERSION, sections: { team: "任务 {{issueNumber}}" } });
    expect(() => loadPrompts(dir)).toThrow(/未知占位符 \{\{issueNumber\}\}/);
  });

  test("丢数据的覆盖被拒绝：intro 缺任务号、context 缺上下文、task 缺需求正文", () => {
    const { dir } = workspace();
    for (const [sections, missing] of [
      [{ intro: "开始干活。" }, "{{taskId}}"],
      [{ context: "## 上下文" }, "{{context}}"],
      [{ task: "## 任务\n照做" }, "{{prompt}}"],
    ] as const) {
      writeOverride(dir, { version: PROMPT_VERSION, sections });
      expect(() => loadPrompts(dir)).toThrow(new RegExp(`必须包含 \\{\\{${missing.slice(2, -2)}\\}\\}`));
    }
  });

  test("prompts/ 下的未知 json 文件被拒绝", () => {
    const { dir } = workspace();
    writeOverride(dir, { version: PROMPT_VERSION, sections: { team: "团队" } }, "team.json");
    expect(() => loadPrompts(dir)).toThrow(/未知的提示词文件 team.json/);
  });

  test("JSON 语法错误带上文件路径", () => {
    const { dir } = workspace();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PROMPT_OVERRIDE_FILE), "{oops");
    expect(() => loadPrompts(dir)).toThrow(PromptConfigError);
    expect(() => loadPrompts(dir)).toThrow(/JSON 解析失败/);
  });
});

describe("提示词查看与 diff", () => {
  const override: PromptBundle = {
    version: PROMPT_VERSION,
    sections: { ...BUILTIN_PROMPTS.sections, team: "## 团队约定\n- 用 bun" },
    overrides: ["team"],
    source: "/tmp/prompts/overrides.json",
  };

  test("概览包含版本、覆盖来源、段落顺序与 diff", () => {
    const text = formatPromptReport(override);
    expect(text).toContain(`提示词版本：${PROMPT_VERSION}`);
    expect(text).toContain("/tmp/prompts/overrides.json");
    expect(text).toContain("覆盖段落：team");
    expect(text).toContain("段落顺序：intro · team · resume · context · task · guard");
    expect(text).toContain("--- 内置/team");
    expect(text).toContain("+++ 覆盖/team");
    expect(text).toContain("+## 团队约定");
  });

  test("没有覆盖时明确说明全部内置", () => {
    expect(formatPromptReport(BUILTIN_PROMPTS)).toContain("无（全部内置）");
    expect(formatPromptDiff(BUILTIN_PROMPTS)).toBe("没有覆盖，全部使用内置提示词。");
  });

  test("替换内置段落时 diff 同时出现删除行与新增行", () => {
    const diff = formatPromptDiff({
      version: PROMPT_VERSION,
      sections: { ...BUILTIN_PROMPTS.sections, guard: "## 新约束\n- 只改前端" },
      overrides: ["guard"],
      source: "/tmp/prompts/overrides.json",
    });
    expect(diff).toContain("-## 约束（以下由 pisa guard 强制");
    expect(diff).toContain("+## 新约束");
  });
});
