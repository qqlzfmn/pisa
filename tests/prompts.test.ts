import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatPrompts, PromptError, PromptLibrary, renderWorkerPrompt } from "../src/prompts";
import type { Task } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-prompts-"));
  roots.push(dir);
  return dir;
}

function writeFile(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

const BUILTIN = `---
version: 1
---

<!-- section: intro -->
内置 intro {{taskId}}

<!-- section: resume -->
内置 resume {{taskId}}

<!-- section: context -->
内置 context: {{context}}

<!-- section: task -->
内置 task: {{prompt}}

<!-- section: constraints -->
内置 constraints {{taskId}}
`;

const TEAM = `---
version: 2
---

<!-- section: task -->
团队 task: {{prompt}}
`;

const REPO = `---
version: 3
---

<!-- section: intro -->
仓库 intro {{taskId}}
`;

interface Fixture {
  builtin?: string | null;
  team?: string;
  repo?: string;
}

function library(opts: Fixture = {}): PromptLibrary {
  const builtinDir = tempDir();
  if (opts.builtin !== null) writeFile(join(builtinDir, "worker.md"), opts.builtin ?? BUILTIN);
  const teamDir = tempDir();
  if (opts.team !== undefined) writeFile(join(teamDir, "worker.md"), opts.team);
  if (opts.repo !== undefined) writeFile(join(teamDir, "repos", "demo.md"), opts.repo);
  return new PromptLibrary({ builtinDir, teamDir });
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t_x",
    source: "test",
    channel: "cli",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "修登录",
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
    ...over,
  };
}

describe("提示词分层", () => {
  test("仓库覆盖团队，团队覆盖内置，未覆盖段落回退内置", () => {
    const resolved = library({ team: TEAM, repo: REPO }).resolve("demo");
    expect(resolved.builtinVersion).toBe(1);
    expect(resolved.teamVersion).toBe(2);
    expect(resolved.repoVersion).toBe(3);
    expect(resolved.sections.intro).toMatchObject({ source: "repo", version: 3 });
    expect(resolved.sections.task).toMatchObject({ source: "team", version: 2 });
    expect(resolved.sections.constraints).toMatchObject({ source: "builtin", version: 1 });
    expect(resolved.sections.resume.text).toBe("内置 resume {{taskId}}");
  });

  test("渲染顺序固定：intro → resume → context → task → constraints", () => {
    const resolved = library({ team: TEAM, repo: REPO }).resolve("demo");
    const text = renderWorkerPrompt(resolved, task({ context: "上一轮改了 A" }), { resume: true });
    expect(text).toBe(
      [
        "仓库 intro t_x",
        "内置 resume t_x",
        "内置 context: 上一轮改了 A",
        "团队 task: 修登录",
        "内置 constraints t_x",
      ].join("\n\n"),
    );
  });

  test("新任务不带恢复段与上下文档", () => {
    const text = renderWorkerPrompt(library().resolve("demo"), task());
    expect(text).not.toContain("内置 resume");
    expect(text).not.toContain("内置 context");
    expect(text).toBe(["内置 intro t_x", "内置 task: 修登录", "内置 constraints t_x"].join("\n\n"));
  });

  test("正文里的占位符不会被二次替换", () => {
    const text = renderWorkerPrompt(library().resolve("demo"), task({ prompt: "保留 {{taskId}} 字面量" }));
    expect(text).toContain("内置 task: 保留 {{taskId}} 字面量");
  });

  test("没有团队目录时只用内置", () => {
    const builtinDir = tempDir();
    writeFile(join(builtinDir, "worker.md"), BUILTIN);
    const resolved = new PromptLibrary({ builtinDir, teamDir: join(builtinDir, "missing") }).resolve("demo");
    for (const section of Object.values(resolved.sections)) expect(section.source).toBe("builtin");
    expect(resolved.teamVersion).toBeNull();
    expect(resolved.repoVersion).toBeNull();
  });

  test("非法仓库别名不拼路径，直接忽略仓库层", () => {
    const resolved = library({ team: TEAM, repo: REPO }).resolve("../escape");
    expect(resolved.sections.intro.source).toBe("builtin");
    expect(resolved.sections.task.source).toBe("team");
  });
});

describe("提示词配置校验", () => {
  const cases: Array<[string, Fixture, RegExp]> = [
    ["缺少内置文件", { builtin: null }, /提示词文件缺失/],
    ["内置文件缺段落", { builtin: `---\nversion: 1\n---\n\n<!-- section: intro -->\nx\n` }, /缺少段落 resume, context, task, constraints/],
    ["未知 front matter 键", { team: `---\nversion: 1\nowner: me\n---\n<!-- section: task -->\nx\n` }, /未知 front matter 键/],
    ["缺少 version", { team: `---\n---\n<!-- section: task -->\nx\n` }, /缺少 version/],
    ["version 不是正整数", { team: `---\nversion: 0\n---\n<!-- section: task -->\nx\n` }, /version 必须是/],
    ["未知段落", { team: `---\nversion: 1\n---\n<!-- section: extra -->\nx\n` }, /未知段落/],
    ["重复段落", { team: `---\nversion: 1\n---\n<!-- section: task -->\na\n<!-- section: task -->\nb\n` }, /重复/],
    ["空段落", { team: `---\nversion: 1\n---\n<!-- section: task -->\n\n` }, /为空/],
    ["段落标记前有正文", { team: `---\nversion: 1\n---\n散落文本\n<!-- section: task -->\nx\n` }, /第一个段落标记之前/],
    ["没有任何段落", { team: `---\nversion: 1\n---\n` }, /没有任何段落/],
    ["仓库文件非法", { repo: `---\nversion: 1\n---\n<!-- section: nope -->\nx\n` }, /未知段落/],
  ];

  for (const [name, fixture, message] of cases) {
    test(name, () => {
      const lib = library(fixture);
      expect(() => lib.validate(["demo"])).toThrow(PromptError);
      expect(() => lib.validate(["demo"])).toThrow(message);
    });
  }

  test("仓库清单为空也校验团队层", () => {
    const lib = library({ team: `---\nversion: 1\n---\n<!-- section: extra -->\nx\n` });
    expect(() => lib.validate([])).toThrow(/未知段落/);
  });
});

describe("formatPrompts", () => {
  test("视图列出各层版本与段落来源", () => {
    const text = formatPrompts([library({ team: TEAM, repo: REPO }).resolve("demo")]);
    expect(text).toContain("[demo] worker · 内置 v1 · 团队 v2 · 仓库 v3");
    expect(text).toMatch(/intro\s+仓库 v3/);
    expect(text).toMatch(/task\s+团队 v2/);
    expect(text).toMatch(/constraints\s+内置 v1/);
  });

  test("diff 只展开被覆盖的段落", () => {
    const text = formatPrompts([library({ team: TEAM, repo: REPO }).resolve("demo")], { diff: true });
    expect(text).toContain("intro · 内置 v1 → 仓库 v3");
    expect(text).toContain("task · 内置 v1 → 团队 v2");
    expect(text).toContain("--- 内置 v1");
    expect(text).toContain("+++ 团队 v2");
    expect(text).toContain("-内置 task: {{prompt}}");
    expect(text).toContain("+团队 task: {{prompt}}");
    expect(text).not.toContain("constraints · 内置");
  });

  test("只有版本变化时明确提示内容未改", () => {
    const same = `---\nversion: 2\n---\n\n<!-- section: task -->\n内置 task: {{prompt}}\n`;
    const text = formatPrompts([library({ team: same }).resolve("demo")], { diff: true });
    expect(text).toContain("内容未改，仅版本不同");
  });

  test("没有覆盖时说明全部使用内置", () => {
    const text = formatPrompts([library().resolve(null)], { diff: true });
    expect(text).toContain("全部段落使用内置 v1");
    expect(text).not.toContain("[");
  });
});
