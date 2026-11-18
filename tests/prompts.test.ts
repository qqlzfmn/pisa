import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BUILTIN_PROMPT_VERSION,
  DEFAULT_PROMPTS,
  PromptError,
  describePrompts,
  diffPrompts,
  formatPromptsCommand,
  loadPrompts,
  parsePromptsQuery,
  promptSections,
  renderPrompt,
} from "../src/prompts";
import { loadConfig, promptsOf } from "../src/config";
import { buildPrompt } from "../src/adapters/omp";
import { buildReviewPrompt } from "../src/pr-review";
import { runCli } from "../src/cli";
import type { Task } from "../src/types";

let dir: string;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pisa-prompts-"));
  dir = join(root, "prompts");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, text: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const task: Task = {
  id: "t_1",
  source: "cli",
  channel: "cli",
  chatId: "cli",
  requester: "u1",
  repo: "demo",
  prompt: "修登录超时",
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

const pr = {
  number: 7,
  head: "feat",
  headSha: "abc123",
  title: "加登录",
  baseRefName: "main",
  url: "https://github.com/o/r/pull/7",
};

describe("内置提示词", () => {
  test("没有覆盖目录时退回内置，版本取内置版本", () => {
    const lib = loadPrompts(join(root, "missing"));
    expect(lib).toEqual(DEFAULT_PROMPTS);
    expect(lib.version).toBe(BUILTIN_PROMPT_VERSION);
    expect(lib.dir).toBeNull();
  });

  test("worker 段落顺序固定：开场 → 任务 → 约束", () => {
    const text = renderPrompt(DEFAULT_PROMPTS, "worker", { taskId: "t_1", prompt: "做 A" });
    expect(text).toBe(
      [
        "你是 pisa 的 Worker，任务号 t_1。",
        "",
        "## 任务",
        "做 A",
        "",
        "## 约束（以下由 pisa guard 强制，越界调用会被拒绝）",
        "- 文件读写、编辑只能落在工作目录内；git 的 -C / --work-tree / --git-dir 也只能指向工作目录",
        "- 禁止 git push（任意形态）、reset --hard、clean -f、切换分支、worktree remove/prune、branch -D、rebase、commit --amend",
        "- 禁止 sudo、删除根目录、改动 /etc 权限",
        "- 提交与推送由 pisa 在任务结束后完成，不需要你操作",
        "- 有测试就跑测试；没有测试就说明你如何验证",
        "- 完成后用中文给出：改了什么、动了哪些文件、验证结果",
        "- 不要输出寒暄，直接给结论",
      ].join("\n"),
    );
    expect(text).not.toContain("恢复执行");
  });

  test("恢复与上下文按变量开关出现，顺序在任务之前", () => {
    const text = renderPrompt(DEFAULT_PROMPTS, "worker", {
      taskId: "t_1",
      prompt: "做 A",
      resume: "1",
      context: "上一轮改了配置",
    });
    expect(text).toContain("## 恢复执行");
    expect(text).toContain("上一轮改了配置");
    expect(text.indexOf("## 恢复执行")).toBeLessThan(text.indexOf("## 上一轮上下文"));
    expect(text.indexOf("## 上一轮上下文")).toBeLessThan(text.indexOf("## 任务"));

    const plain = renderPrompt(DEFAULT_PROMPTS, "worker", { taskId: "t_1", prompt: "做 A", resume: " ", context: "" });
    expect(plain).not.toContain("## 上一轮上下文");
  });

  test("评审段落顺序：头部 → 要求 → Diff", () => {
    const text = renderPrompt(DEFAULT_PROMPTS, "review", {
      repo: "o/r",
      number: "7",
      title: "加登录",
      base: "main",
      head: "feat",
      headSha: "abc123",
      url: "u",
      diff: "+x",
    });
    expect(text.startsWith("评审 PR o/r#7：加登录")).toBe(true);
    expect(text.indexOf("## 要求")).toBeLessThan(text.indexOf("## Diff"));
    expect(text).toContain("+x");
  });
});

describe("覆盖组合顺序", () => {
  test("仓库 > 团队 > 内置", () => {
    write("version", "4\n");
    write("worker.task.md", "## 团队任务\n{{prompt}}");
    write("repos/demo/worker.task.md", "## 仓库任务\n{{prompt}}");

    const lib = loadPrompts(dir);
    expect(lib.version).toBe(4);

    const vars = { taskId: "t_1", prompt: "修 bug" };
    expect(renderPrompt(lib, "worker", vars, "demo")).toContain("## 仓库任务");
    expect(renderPrompt(lib, "worker", vars, "other")).toContain("## 团队任务");
    expect(renderPrompt(lib, "worker", vars)).toContain("## 团队任务");

    const layers = promptSections(lib, "demo");
    expect(layers.find((s) => s.key === "worker.task")?.layer).toBe("repo");
    expect(layers.find((s) => s.key === "worker.guard")?.layer).toBe("builtin");
  });

  test("仓库评审标准按 owner__repo 覆盖，未覆盖时退回团队层", () => {
    write("version", "2\n");
    write("review.criteria.md", "- 团队标准：覆盖到边界");
    write("repos/o__r/review.criteria.md", "- 仓库标准：只看公开 API");

    const lib = loadPrompts(dir);
    const vars = {
      repo: "o/r",
      number: "7",
      title: "加登录",
      base: "main",
      head: "feat",
      headSha: "abc123",
      url: "u",
      diff: "+x",
    };
    const own = renderPrompt(lib, "review", vars, "o__r");
    expect(own).toContain("- 仓库标准：只看公开 API");
    expect(own).not.toContain("- 团队标准");
    expect(own.indexOf("## 要求")).toBeLessThan(own.indexOf("## Diff"));

    const other = renderPrompt(lib, "review", vars, "o__other");
    expect(other).toContain("- 团队标准：覆盖到边界");
    // 没有覆盖时 review.criteria 不进入提示词
    expect(renderPrompt(DEFAULT_PROMPTS, "review", vars)).not.toContain("评审标准");
  });

  test("覆盖文本里的 {{...}} 只替换一次，正文里的同名文本保持原样", () => {
    write("version", "1\n");
    write("worker.task.md", "## 任务\n{{prompt}}");

    const lib = loadPrompts(dir);
    const text = renderPrompt(lib, "worker", { taskId: "t_1", prompt: "保留 {{taskId}} 字面量" });
    expect(text).toContain("保留 {{taskId}} 字面量");
  });

  test("段落开关优先于覆盖：没有 resume 时覆盖段落也不出现", () => {
    write("version", "1\n");
    write("worker.resume.md", "## 自定义恢复段");

    const lib = loadPrompts(dir);
    expect(renderPrompt(lib, "worker", { taskId: "t_1", prompt: "做 A" })).not.toContain("自定义恢复段");
    expect(renderPrompt(lib, "worker", { taskId: "t_1", prompt: "做 A", resume: "1" })).toContain("## 自定义恢复段");
  });
});

describe("非法配置", () => {
  const cases: Array<[string, () => void, RegExp]> = [
    ["未知键", () => {
      write("version", "1\n");
      write("worker.nope.md", "x");
    }, /未知提示词键/],
    ["有覆盖但缺 version", () => {
      write("worker.task.md", "{{prompt}}");
    }, /缺少 .*version/],
    ["version 不是正整数", () => {
      write("version", "0\n");
    }, /version 必须是从 1 开始的整数/],
    ["version 非数字", () => {
      write("version", "abc\n");
      write("worker.task.md", "{{prompt}}");
    }, /version 必须是从 1 开始的整数/],
    ["未知变量", () => {
      write("version", "1\n");
      write("worker.task.md", "{{taskId}} 不允许出现在这里");
    }, /未知提示词变量 \{\{taskId\}\}/],
    ["空覆盖", () => {
      write("version", "1\n");
      write("worker.task.md", "  \n");
    }, /提示词覆盖为空/],
    ["非 .md 文件", () => {
      write("version", "1\n");
      write("notes.txt", "x");
    }, /只允许 <键>\.md/],
    ["未知子目录", () => {
      write("version", "1\n");
      write("extra/x.md", "x");
    }, /只允许 repos\/ 子目录/],
    ["仓库目录名不合法", () => {
      write("version", "1\n");
      write("repos/bad name/worker.task.md", "{{prompt}}");
    }, /仓库覆盖目录名不合法/],
    ["仓库目录里出现子目录", () => {
      write("version", "1\n");
      write("repos/demo/nested/worker.task.md", "{{prompt}}");
    }, /不允许子目录/],
  ];

  for (const [name, prepare, pattern] of cases) {
    test(name, () => {
      prepare();
      expect(() => loadPrompts(dir)).toThrow(PromptError);
      expect(() => loadPrompts(dir)).toThrow(pattern);
    });
  }

  test("只有 version 没有覆盖：合法，版本按文件读取", () => {
    write("version", "7\n");
    expect(loadPrompts(dir).version).toBe(7);
  });
});

describe("渲染校验", () => {
  test("缺变量时报错而不是输出半成品", () => {
    expect(() => renderPrompt(DEFAULT_PROMPTS, "worker", { taskId: "t_1" })).toThrow(PromptError);
  });
});

describe("启动加载", () => {
  function writeConfig(): string {
    const configPath = join(root, "pisa.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ stateDir: join(root, "state"), promptsDir: dir, worker: { command: "noop" } }),
    );
    return configPath;
  }

  test("loadConfig 按 promptsDir 加载覆盖并带上版本", () => {
    write("version", "5\n");
    write("worker.guard.md", "## 团队约束\n- 只有一条");
    const cfg = loadConfig(writeConfig());

    expect(cfg.promptsDir).toBe(dir);
    expect(cfg.prompts?.version).toBe(5);
    expect(promptsOf(cfg)).toBe(cfg.prompts!);
    expect(renderPrompt(promptsOf(cfg), "worker", { taskId: "t_1", prompt: "做 A" }, "demo")).toContain("## 团队约束");
  });

  test("坏配置让启动直接失败", () => {
    write("version", "1\n");
    write("worker.nope.md", "x");
    expect(() => loadConfig(writeConfig())).toThrow(/未知提示词键/);
  });
});

describe("/pisa prompts", () => {
  function lib() {
    write("version", "6\n");
    write("worker.task.md", "## 团队任务\n{{prompt}}");
    write("repos/demo/worker.task.md", "## 仓库任务\n{{prompt}}");
    return loadPrompts(dir);
  }

  test("列出各段来源与版本", () => {
    const text = formatPromptsCommand(lib(), "");
    expect(text).toContain("提示词版本 6（内置 1）");
    expect(text).toContain(`覆盖目录 ${dir}`);
    expect(text).toContain("worker.task");
    expect(text).toContain("团队");
    expect(text).toContain("review.criteria");
    expect(text).toContain("未设置（跳过）");

    const scoped = formatPromptsCommand(lib(), "--repo demo");
    expect(scoped).toContain("仓库视角 demo");
    expect(scoped).toContain("仓库 demo");
  });

  test("diff 按层对比：内置 → 团队 → 仓库", () => {
    const team = formatPromptsCommand(lib(), "diff worker.task");
    expect(team).toContain("--- 内置 worker.task");
    expect(team).toContain("+++ 团队 worker.task");
    expect(team).toContain("-## 任务");
    expect(team).toContain("+## 团队任务");

    const repo = formatPromptsCommand(lib(), "diff worker.task --repo demo");
    expect(repo).toContain("+++ 团队 worker.task");
    expect(repo).toContain("+++ 仓库 demo worker.task");
    expect(repo).toContain("+## 仓库任务");
  });

  test("没有覆盖时说明使用内置", () => {
    expect(diffPrompts(loadPrompts(dir), "review.diff")).toBe("review.diff：没有覆盖，使用内置文本");
  });

  test("未知键与非法参数给用法", () => {
    const unknown = formatPromptsCommand(lib(), "diff worker.nope");
    expect(unknown).toContain("未知提示词键：worker.nope");
    expect(unknown).toContain("worker.intro");
    expect(formatPromptsCommand(lib(), "diff")).toContain("用法：/pisa prompts diff <键>");
    expect(formatPromptsCommand(lib(), "wat")).toBe("用法：/pisa prompts [diff <键>] [--repo <仓库>]");
    expect(parsePromptsQuery("diff worker.task --repo").error).toBe("用法：/pisa prompts [diff <键>] [--repo <仓库>]");
  });
});

describe("CLI prompts", () => {
  async function cli(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  function prepare(): string {
    write("version", "3\n");
    write("worker.guard.md", "## 团队约束\n- 只有一条");
    const configPath = join(root, "pisa.config.json");
    writeFileSync(configPath, JSON.stringify({ stateDir: join(root, "state"), promptsDir: dir }));
    return configPath;
  }

  test("pisa prompts 输出与 JSON", async () => {
    const configPath = prepare();
    const text = await cli("prompts", "--config", configPath);
    expect(text.code).toBe(0);
    expect(text.out).toContain("提示词版本 3（内置 1）");

    const parsed = await cli("prompts", "--json", "--config", configPath);
    expect(parsed.code).toBe(0);
    const body = JSON.parse(parsed.out) as { version: number; sections: Array<{ key: string; layer: string }> };
    expect(body.version).toBe(3);
    expect(body.sections.find((s) => s.key === "worker.guard")?.layer).toBe("team");
  });

  test("pisa prompts diff 与非法键", async () => {
    const configPath = prepare();
    const diff = await cli("prompts", "diff", "worker.guard", "--json", "--config", configPath);
    expect(diff.code).toBe(0);
    const body = JSON.parse(diff.out) as { key: string; diff: string };
    expect(body.key).toBe("worker.guard");
    expect(body.diff).toContain("+## 团队约束");

    const bad = await cli("prompts", "diff", "worker.nope", "--config", configPath);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("未知提示词键");
  });
});

describe("接线", () => {
  test("Worker 与 PR 评审提示词走覆盖", () => {
    write("version", "1\n");
    write("worker.task.md", "## 团队任务\n{{prompt}}");
    write("repos/o__r/review.criteria.md", "- 仓库标准：只看公开 API");
    const lib = loadPrompts(dir);

    expect(buildPrompt(task, { prompts: lib })).toContain("## 团队任务");
    expect(buildPrompt({ ...task, context: "上一轮" }, { prompts: lib, resume: true })).toContain("## 恢复执行");

    const review = buildReviewPrompt("o/r", pr, "diff --git a/a.ts b/a.ts\n+x", lib);
    expect(review).toContain("- 仓库标准：只看公开 API");
    expect(review).toContain("+x");
    expect(review).toContain("abc123");

    expect(buildPrompt(task)).toContain("你是 pisa 的 Worker，任务号 t_1。");
    expect(describePrompts(DEFAULT_PROMPTS)).toContain("覆盖目录 未使用");
  });
});
