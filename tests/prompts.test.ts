import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUILTIN_PROMPTS,
  BUILTIN_PROMPT_VERSION,
  PromptConfigError,
  buildWorkerPrompt,
  formatPrompts,
  loadPrompts,
  resolvePrompt,
  type PromptBook,
} from "../src/prompts";
import type { Task } from "../src/types";

const task: Task = {
  id: "t_1",
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

/** 在临时目录里摆出覆盖文件，跑完即删 */
function withPrompts<T>(files: Record<string, string>, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pisa-prompts-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("内置提示词", () => {
  test("段落顺序固定：intro → resume → context → task → constraints", () => {
    const resumed = { ...task, context: "上一轮改了登录页" };
    const text = buildWorkerPrompt(BUILTIN_PROMPTS, resumed, { resume: true });
    const positions = [
      "你是 pisa 的 Worker",
      "## 恢复执行",
      "## 上一轮上下文",
      "## 任务",
      "## 约束",
    ].map((marker) => text.indexOf(marker));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("新任务省略恢复段，无上下文时省略上下文段", () => {
    const text = buildWorkerPrompt(BUILTIN_PROMPTS, task);
    expect(text).not.toContain("## 恢复执行");
    expect(text).not.toContain("## 上一轮上下文");
    expect(text).toContain("你是 pisa 的 Worker，任务号 t_1。");
    expect(text).toContain("## 任务\n修一下登录");
  });

  test("没有覆盖目录时回退到内置", () => {
    const book = loadPrompts(join(tmpdir(), "pisa-prompts-missing"), ["demo"]);
    expect(book).toBe(BUILTIN_PROMPTS);
    expect(book.version).toBe(BUILTIN_PROMPT_VERSION);
    expect(resolvePrompt(book, "worker.intro").source).toBe("builtin");
  });
});

describe("加载覆盖", () => {
  test("团队覆盖只替换对应段落，其余回退内置", () => {
    withPrompts(
      {
        VERSION: "2\n",
        "worker.task.md": "## 任务\n{{prompt}}\n\n先读 AGENTS.md",
        "worker.constraints.md": "## 评审标准\n按仓库约定评审。",
      },
      (dir) => {
        const book = loadPrompts(dir, ["demo"]);
        expect(book.version).toBe(2);
        expect(resolvePrompt(book, "worker.task").source).toBe("team");
        expect(resolvePrompt(book, "worker.intro").source).toBe("builtin");

        const text = buildWorkerPrompt(book, task);
        expect(text).toContain("先读 AGENTS.md");
        expect(text).toContain("按仓库约定评审。");
        expect(text).not.toContain("以下由 pisa guard 强制");
        expect(text).toContain("你是 pisa 的 Worker，任务号 t_1。");
      },
    );
  });

  test("仓库覆盖优先于团队覆盖，其它仓库回退团队", () => {
    withPrompts(
      {
        VERSION: "3\n",
        "worker.task.md": "## 任务\n团队版",
        "repos/demo/worker.task.md": "## 任务\n仓库版 {{prompt}}",
      },
      (dir) => {
        const book = loadPrompts(dir, ["demo", "other"]);
        expect(resolvePrompt(book, "worker.task", "demo").source).toBe("repo:demo");
        expect(buildWorkerPrompt(book, task)).toContain("仓库版 修一下登录");
        expect(resolvePrompt(book, "worker.task", "other").source).toBe("team");
        expect(resolvePrompt(book, "worker.task", "unconfigured").source).toBe("team");
      },
    );
  });

  test("仓库覆盖未提及的段落仍用内置", () => {
    withPrompts(
      { VERSION: "2\n", "repos/demo/worker.context.md": "## 历史\n{{context}}" },
      (dir) => {
        const book = loadPrompts(dir, ["demo"]);
        const text = buildWorkerPrompt(book, { ...task, context: "上一次的结论" }, { resume: true });
        expect(text).toContain("## 历史\n上一次的结论");
        expect(resolvePrompt(book, "worker.resume", "demo").source).toBe("builtin");
      },
    );
  });
});

describe("非法配置", () => {
  test("未知段落键拒绝启动", () => {
    withPrompts({ VERSION: "1\n", "worker.unknown.md": "x" }, (dir) => {
      expect(() => loadPrompts(dir, ["demo"])).toThrow(/未知的提示词键/);
    });
  });

  test("未知仓库别名拒绝启动", () => {
    withPrompts({ VERSION: "1\n", "repos/nope/worker.task.md": "x" }, (dir) => {
      expect(() => loadPrompts(dir, ["demo"])).toThrow(/未知的仓库别名 nope/);
    });
  });

  test("缺少 VERSION 或版本号非法时拒绝启动", () => {
    withPrompts({ "worker.task.md": "x" }, (dir) => {
      expect(() => loadPrompts(dir, ["demo"])).toThrow(/缺少 VERSION/);
    });
    withPrompts({ VERSION: "0\n" }, (dir) => {
      expect(() => loadPrompts(dir, ["demo"])).toThrow(/版本必须是正整数/);
    });
    withPrompts({ VERSION: "abc\n" }, (dir) => {
      expect(() => loadPrompts(dir, ["demo"])).toThrow(/版本必须是正整数/);
    });
  });

  test("空覆盖文件与未知模板变量拒绝启动", () => {
    withPrompts({ VERSION: "1\n", "worker.task.md": "  \n" }, (dir) => {
      expect(() => loadPrompts(dir, ["demo"])).toThrow(/空文件/);
    });
    withPrompts({ VERSION: "1\n", "worker.intro.md": "任务 {{taskID}}" }, (dir) => {
      expect(() => loadPrompts(dir, ["demo"])).toThrow(PromptConfigError);
      expect(() => loadPrompts(dir, ["demo"])).toThrow(/未知变量 \{\{taskID\}\}/);
    });
    withPrompts({ VERSION: "1\n", "worker.resume.md": "{{prompt}}" }, (dir) => {
      expect(() => loadPrompts(dir, ["demo"])).toThrow(/未知变量 \{\{prompt\}\}/);
    });
  });
});

describe("查看与 diff", () => {
  const book = (): PromptBook =>
    withPrompts(
      { VERSION: "4\n", "worker.constraints.md": "## 评审标准\n只看行为。" },
      (dir) => loadPrompts(dir, ["demo"]),
    );

  test("列表显示版本与每个段落的生效来源", () => {
    const text = formatPrompts(book());
    expect(text).toContain("提示词 v4");
    expect(text).toContain("团队覆盖 1 段");
    expect(text).toContain("worker.constraints · 团队");
    expect(text).toMatch(/worker\.intro\s+· 内置/);
    expect(text).toContain("覆盖目录：");
  });

  test("diff 只显示被覆盖的段落", () => {
    const text = formatPrompts(book(), { diff: true });
    expect(text).toContain("## worker.constraints（团队）");
    expect(text).toContain("--- 内置");
    expect(text).toContain("+++ 团队");
    expect(text).toContain("-## 约束（以下由 pisa guard 强制，越界调用会被拒绝）");
    expect(text).toContain("+## 评审标准");
    expect(text).not.toContain("## worker.intro");
  });

  test("没有覆盖时 diff 说明全部使用内置", () => {
    const text = formatPrompts(BUILTIN_PROMPTS, { diff: true });
    expect(text).toContain("没有覆盖，全部使用内置。");
    expect(text).not.toContain("--- 内置");
  });

  test("按仓库解析覆盖来源", () => {
    const repoBook = withPrompts(
      {
        VERSION: "2\n",
        "worker.constraints.md": "团队标准",
        "repos/demo/worker.constraints.md": "仓库标准",
      },
      (dir) => loadPrompts(dir, ["demo"]),
    );
    expect(formatPrompts(repoBook, { repo: "demo" })).toMatch(/worker\.constraints · 仓库 demo/);
    expect(formatPrompts(repoBook)).toContain("worker.constraints · 团队");
  });
});

describe("变量替换", () => {
  test("团队模板可以使用本段允许的变量", () => {
    withPrompts({ VERSION: "1\n", "worker.task.md": "[{{prompt}}]" }, (dir) => {
      const text = buildWorkerPrompt(loadPrompts(dir, ["demo"]), task);
      expect(text).toContain("[修一下登录]");
    });
  });
});
