import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { helpText } from "../src/cli";

const ROOT = resolve(import.meta.dir, "..");
const DOCS = ["domain.md", "deployment.md", "extending.md"] as const;
const md = new Map(DOCS.map((name) => [name, readFileSync(join(ROOT, "docs", name), "utf8")]));

/** 反引号里引用的仓库路径（去掉行号与锚点） */
function referencedPaths(text: string): string[] {
  const refs = new Set<string>();
  for (const m of text.matchAll(/`((?:src|scripts|extensions|docs)\/[^`\s]+)`/g)) {
    const path = m[1];
    if (path) refs.add(path.replace(/#.*$/, "").replace(/:\d+(-\d+)?$/, ""));
  }
  return [...refs];
}

/** helpText 的退出码段：`0 成功    1 任务失败…` */
function helpExitCodes(): Map<number, string> {
  const text = helpText();
  const start = text.indexOf("退出码：");
  expect(start).toBeGreaterThan(-1);
  const codes = new Map<number, string>();
  for (const m of text.slice(start + "退出码：".length).matchAll(/(\d)\s+([^0-9]+?)(?=\s{2,}\d\s|$)/g)) {
    const code = m[1];
    const meaning = m[2]?.trim();
    if (code && meaning) codes.set(Number(code), meaning);
  }
  return codes;
}

/** deployment.md 的 CLI 退出码表：`| 0 | 成功 |` */
function docExitCodes(): Map<number, string> {
  const codes = new Map<number, string>();
  const [cli] = (md.get("deployment.md") ?? "").split("## 9. 退出码")[1]?.split("守护进程") ?? [];
  for (const line of (cli ?? "").split("\n")) {
    const m = /^\| (\d) \| ([^|]+?) \|$/.exec(line);
    const code = m?.[1];
    const meaning = m?.[2]?.trim();
    if (code && meaning) codes.set(Number(code), meaning);
  }
  return codes;
}

describe("贡献者文档", () => {
  test("三份文档存在且与 architecture.md 互链", () => {
    const architecture = readFileSync(join(ROOT, "docs/architecture.md"), "utf8");
    for (const name of DOCS) {
      expect(architecture).toContain(`[${name}](./${name})`);
      expect(md.get(name)).toContain("[architecture.md](./architecture.md)");
    }
  });

  test("文档引用的仓库路径全部存在", () => {
    const missing: string[] = [];
    let count = 0;
    for (const name of DOCS) {
      const refs = referencedPaths(md.get(name) ?? "");
      count += refs.length;
      for (const ref of refs) {
        if (!existsSync(join(ROOT, ref))) missing.push(`docs/${name}: ${ref}`);
      }
    }
    expect(count).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  test("deployment.md 的 CLI 退出码与 helpText 一致", () => {
    const expected = helpExitCodes();
    expect(expected.size).toBe(6);
    expect(docExitCodes()).toEqual(expected);
  });
});
