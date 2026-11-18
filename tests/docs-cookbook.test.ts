import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../src/adapters";
import { STAGE_RULES } from "../src/stage";
import { ALLOWED } from "../src/types";

const ROOT = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

const DOCS = ["docs/domain.md", "docs/deployment.md", "docs/extending.md"];

/** 取某个二级标题下的正文（到下一个同级或更高级标题为止） */
function section(md: string, heading: string): string {
  const start = md.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = md.slice(start + heading.length);
  const end = rest.search(/\n#{1,3} /);
  return end === -1 ? rest : rest.slice(0, end);
}

function tableColumn(block: string, pattern: RegExp): string[] {
  return [...block.matchAll(pattern)].map((m) => m[1]!);
}

describe("文档手册", () => {
  test("三份文档存在并与 architecture.md 互链", () => {
    const architecture = read("docs/architecture.md");
    for (const path of DOCS) {
      const md = read(path);
      expect(md).toContain("./architecture.md");
      expect(architecture).toContain(path.replace(/^docs\//, "./"));
    }
  });

  test("退出码表覆盖 CLI 与守护进程的全部取值", () => {
    const block = read("src/cli.ts").match(/const EXIT = \{([\s\S]*?)\} as const;/)?.[1] ?? "";
    const cliCodes = [...block.matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(cliCodes.sort()).toEqual([0, 1, 2, 3, 4, 5]);

    const deployment = read("docs/deployment.md");
    const table = section(deployment, "## 退出码");
    const docCodes = tableColumn(table, /^\|\s*`(\d+)`\s*\|/gm).map(Number);
    expect([...new Set(docCodes)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 75]);
    expect(table).toMatch(/75[^\n]*supervis/);
  });

  test("Worker 适配器清单与注册表一致", () => {
    let message = "";
    try {
      getAdapter("__doc_check__");
    } catch (err) {
      message = (err as Error).message;
    }
    const names = message
      .split("可用：")[1]!
      .replace(/）$/, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(0);

    const extending = read("docs/extending.md");
    const table = section(extending, "### Worker 适配器清单");
    const documented = tableColumn(table, /^\|\s*`([a-z0-9-]+)`\s*\|/gm);
    expect(documented.sort()).toEqual([...names].sort());
  });

  test("触发路由与 http.ts 的注册路径一致", () => {
    const source = read("src/triggers/http.ts");
    const routes = tableColumn(source, /routes\.set\(\s*"([^"]+)"/g);
    expect(routes.length).toBeGreaterThan(0);

    const extending = read("docs/extending.md");
    const table = section(extending, "### 触发路由");
    const documented = tableColumn(table, /^\|\s*`(\/[^`]+)`\s*\|/gm);
    expect([...documented].sort()).toEqual([...routes].sort());
  });

  test("术语表覆盖全部状态与阶段", () => {
    const domain = read("docs/domain.md");
    for (const status of Object.keys(ALLOWED)) expect(domain).toContain(`\`${status}\``);
    for (const { stage } of STAGE_RULES) expect(domain).toContain(`\`${stage}\``);
  });

  test("命令块可直接复制执行", () => {
    for (const path of DOCS) {
      const md = read(path);
      for (const [, lang = "", body = ""] of md.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
        if (!["bash", "sh", "shell"].includes(lang)) continue;
        expect(/<[^>\n]+>|\.\.\./.test(body)).toBe(false);
      }
    }
  });
});
