import { describe, expect, test } from "bun:test";
import { buildReviewPrompt } from "../src/pr-review";
import type { OpenPr } from "../src/github";

const REPO = "o/r";
const PR: OpenPr = {
  number: 7,
  head: "feat",
  headSha: "abc123",
  title: "加登录",
  baseRefName: "main",
  url: "https://github.com/o/r/pull/7",
};

describe("buildReviewPrompt", () => {
  test("普通 diff 使用三反引号围栏", () => {
    const prompt = buildReviewPrompt(REPO, PR, "diff --git a/a.ts b/a.ts\n+const x = 1;\n");
    expect(prompt).toContain("\n```diff\n");
    expect(prompt.endsWith("\n```")).toBe(true);
  });

  test("diff 自带代码围栏时加长围栏，内容不会提前闭合", () => {
    const diff = "diff --git a/doc.md b/doc.md\n+```ts\n+console.log(1)\n+```\n";
    const prompt = buildReviewPrompt(REPO, PR, diff);

    expect(prompt).toContain("\n````diff\n");
    expect(prompt.endsWith("\n````")).toBe(true);
    // diff 里的 ``` 仍在评审内容内部，不会被解析成提示词的外层结构
    const body = prompt.slice(prompt.indexOf("````diff"), prompt.lastIndexOf("\n````"));
    expect(body).toContain("+```ts");
    expect(body).toContain("+```");
  });
});
