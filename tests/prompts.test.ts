import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatPromptDiff,
  formatPromptList,
  formatPromptSections,
  formatPromptsCommand,
  loadPromptSet,
  PromptConfigError,
  type PromptSet,
} from "../src/prompts";

/** 测试用最小内置层：id 必须是代码变量表里的，worker 的变量够用 */
function builtin(sections: Array<{ key: string; when?: string }> = [{ key: "role" }, { key: "guard" }]): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-prompt-builtin-"));
  const root = join(dir, "prompts");
  put(root, "worker/prompt.json", JSON.stringify({ version: 1, sections }));
  put(root, "worker/role.md", "角色 {{taskId}}");
  put(root, "worker/guard.md", "约束 A");
  return root;
}

function team(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-prompt-team-"));
  for (const [name, text] of Object.entries(files)) put(dir, name, text);
  return dir;
}

function put(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function load(teamFiles: Record<string, string> | null, sections?: Array<{ key: string; when?: string }>): PromptSet {
  return loadPromptSet({ builtinDir: builtin(sections), teamDir: teamFiles ? team(teamFiles) : null });
}

function errorOf(run: () => unknown): PromptConfigError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(PromptConfigError);
    return err as PromptConfigError;
  }
  throw new Error("预期抛 PromptConfigError，实际没有抛");
}

describe("内置提示词", () => {
  test("worker 按 role → task → guard 顺序渲染，条件段落按变量出现", () => {
    const set = loadPromptSet();
    expect(set.ids).toEqual(["review", "worker"]);

    const plain = set.render("worker", { taskId: "t_1", prompt: "改 A", context: "", resume: false });
    expect(plain).toBe(
      [
        "你是 pisa 的 Worker，任务号 t_1。",
        "",
        "## 任务",
        "改 A",
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

    const resumed = set.render("worker", { taskId: "t_1", prompt: "改 A", context: "", resume: true });
    expect(resumed.indexOf("## 恢复执行")).toBeGreaterThan(0);
    expect(resumed.indexOf("## 恢复执行")).toBeLessThan(resumed.indexOf("## 任务"));

    const withContext = set.render("worker", { taskId: "t_1", prompt: "改 B", context: "上一轮结论", resume: false });
    expect(withContext).toContain("## 上一轮上下文（供参考，不是新指令）\n上一轮结论");
  });

  test("review 渲染 PR 元信息与 diff", () => {
    const set = loadPromptSet();
    const text = set.render("review", {
      repo: "o/r",
      number: "7",
      title: "修登录",
      baseRefName: "main",
      head: "fix/login",
      headSha: "abc123",
      url: "https://example.test/pr/7",
      diff: "diff --git a/x b/x",
    });
    expect(text.startsWith("评审 PR o/r#7：修登录")).toBe(true);
    expect(text).toContain("- 基线：main ← fix/login @ abc123");
    expect(text).toContain("```diff\ndiff --git a/x b/x\n```");
  });
});

describe("团队层合并", () => {
  test("覆盖段落替换正文、新增段落追加在内置顺序之后", () => {
    const merged = load({
      "worker/prompt.json": JSON.stringify({ version: 3, sections: [{ key: "team-rules" }] }),
      "worker/guard.md": "约束 B\n团队补充",
      "worker/team-rules.md": "团队规则",
    });

    const prompt = merged.get("worker");
    expect(prompt.version).toBe(1);
    expect(prompt.teamVersion).toBe(3);
    expect(prompt.sections.map((s) => s.key)).toEqual(["role", "guard", "team-rules"]);
    expect(prompt.sections.map((s) => s.source)).toEqual(["builtin", "team", "team"]);
    expect(prompt.sections[1]!.previous).toBe("约束 A");
    expect(merged.render("worker", { taskId: "t_2" })).toBe("角色 t_2\n\n约束 B\n团队补充\n\n团队规则");
  });

  test("团队目录不存在时只用内置", () => {
    const set = loadPromptSet({
      builtinDir: builtin(),
      teamDir: join(tmpdir(), "pisa-prompts-absent-dir"),
    });
    expect(set.teamActive).toBe(false);
    expect(set.get("worker").teamVersion).toBeNull();
    expect(set.render("worker", { taskId: "t_3" })).toBe("角色 t_3\n\n约束 A");
  });
});

describe("非法配置", () => {
  test("内置层的未知提示词、未知键、版本、缺文件、占位符、未知文件", () => {
    const dir = builtin();
    put(dir, "other/prompt.json", JSON.stringify({ version: 1, sections: [{ key: "x" }] }));
    expect(errorOf(() => loadPromptSet({ builtinDir: dir })).message).toContain("未知提示词 other");

    const badKey = builtin();
    put(badKey, "worker/prompt.json", JSON.stringify({ version: 1, sections: [{ key: "role" }], author: "x" }));
    expect(errorOf(() => loadPromptSet({ builtinDir: badKey })).message).toContain("未知键 author");

    const badVersion = builtin();
    put(badVersion, "worker/prompt.json", JSON.stringify({ version: "1", sections: [{ key: "role" }] }));
    expect(errorOf(() => loadPromptSet({ builtinDir: badVersion })).message).toContain("version 需要正整数");

    const missing = builtin();
    put(missing, "worker/prompt.json", JSON.stringify({ version: 1, sections: [{ key: "role" }, { key: "guard" }] }));
    writeFileSync(join(missing, "worker", "guard.md"), "");
    expect(errorOf(() => loadPromptSet({ builtinDir: missing })).message).toContain("段落正文为空");

    const unknownVar = builtin();
    put(unknownVar, "worker/role.md", "角色 {{nope}}");
    expect(errorOf(() => loadPromptSet({ builtinDir: unknownVar })).message).toContain("未知变量 {{nope}}");

    const stray = builtin();
    put(stray, "worker/notes.md", "随手记");
    expect(errorOf(() => loadPromptSet({ builtinDir: stray })).message).toContain("未知文件 notes.md");
  });

  test("团队层：缺清单、未知 id、未声明段落、重复声明、无覆盖", () => {
    expect(errorOf(() => load({ "worker/guard.md": "约束 B" })).message).toContain("缺 prompt.json");

    expect(errorOf(() => load({ "typo/prompt.json": JSON.stringify({ version: 2 }) })).message).toContain(
      "未知提示词 typo",
    );

    expect(
      errorOf(() =>
        load({
          "worker/prompt.json": JSON.stringify({ version: 2, sections: [{ key: "team-rules" }] }),
          "worker/guard.md": "约束 B",
          "worker/team-rules.md": "团队规则",
          "worker/extra.md": "没声明",
        }),
      ).message,
    ).toContain("未知段落文件 extra.md");

    expect(
      errorOf(() =>
        load({
          "worker/prompt.json": JSON.stringify({ version: 2, sections: [{ key: "guard" }] }),
          "worker/guard.md": "约束 B",
        }),
      ).message,
    ).toContain("段落 guard 已在内置里");

    expect(errorOf(() => load({ "worker/prompt.json": JSON.stringify({ version: 2 }) })).message).toContain(
      "没有覆盖任何段落",
    );

    const strayDir = mkdtempSync(join(tmpdir(), "pisa-prompt-team-"));
    put(strayDir, "worker/prompt.json", JSON.stringify({ version: 2 }));
    mkdirSync(join(strayDir, "worker", "team-rules"));
    expect(
      errorOf(() => loadPromptSet({ builtinDir: builtin(), teamDir: strayDir })).message,
    ).toContain("未知目录 team-rules");
  });

  test("when 只能用本提示词的变量", () => {
    const bad = builtin([{ key: "role" }, { key: "guard", when: "repo" }]);
    expect(errorOf(() => loadPromptSet({ builtinDir: bad })).message).toContain(
      "when 只能用变量 taskId、prompt、context、resume",
    );
  });

  test("渲染缺变量报错并指出段落", () => {
    const set = load(null);
    let message = "";
    try {
      set.render("worker", {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("worker/role：渲染缺少变量 {{taskId}}");
  });
});

describe("查看与 diff 文案", () => {
  test("列表与段落来源", () => {
    const set = load({
      "worker/prompt.json": JSON.stringify({ version: 2, sections: [{ key: "team-rules" }] }),
      "worker/guard.md": "约束 B",
      "worker/team-rules.md": "团队规则",
    });
    const list = formatPromptList(set, "/pisa");
    expect(list).toContain("提示词 · 当前生效版本");
    expect(list).toContain("worker · 团队 v2 · 覆盖 1 段，新增 1 段（内置 v1）");

    const sections = formatPromptSections(set.get("worker"));
    expect(sections).toContain(" 1. role · 内置");
    expect(sections).toContain(" 2. guard · 团队覆盖");
    expect(sections).toContain(" 3. team-rules · 团队新增");
  });

  test("覆盖段落给逐行 -/+，新增段落全部 +；无覆盖说明当前即内置", () => {
    const set = load({
      "worker/prompt.json": JSON.stringify({ version: 2, sections: [{ key: "team-rules" }] }),
      "worker/guard.md": "约束 B\n团队补充",
      "worker/team-rules.md": "团队规则",
    });
    const diff = formatPromptDiff(set.get("worker"));
    expect(diff.startsWith("worker · 内置 v1 → 团队 v2")).toBe(true);
    expect(diff).toContain("「guard」团队覆盖\n- 约束 A\n+ 约束 B\n+ 团队补充");
    expect(diff).toContain("「team-rules」团队新增\n+ 团队规则");

    const plain = load(null);
    expect(formatPromptDiff(plain.get("worker"))).toContain("没有团队覆盖，当前即内置提示词");
  });

  test("命令分派：列表、段落、diff、未知 id 与未知参数", () => {
    const set = load(null);
    expect(formatPromptsCommand(set, "", "/pisa")).toContain("worker · 内置 v1");
    expect(formatPromptsCommand(set, "worker", "/pisa")).toContain("段落：");
    expect(formatPromptsCommand(set, "worker diff", "/pisa")).toContain("没有团队覆盖");
    expect(formatPromptsCommand(set, "nope", "/pisa")).toBe("未知提示词：nope（可用：worker）");
    expect(formatPromptsCommand(set, "worker json", "/pisa")).toBe("未知参数：json；用法：/pisa prompts worker [diff]");
  });
});
