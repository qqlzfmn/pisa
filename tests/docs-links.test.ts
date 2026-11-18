import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 文档是仓库门面，坏链接比代码 bug 更早被访客撞见。
 * 校验三件事：相对路径有落点；页内锚点落在真实标题上；跨文件锚点落在目标标题上。
 */

const ROOT = join(import.meta.dir, "..");

/** 去掉代码块，示例里的 `[...](...)` 不是链接 */
function prose(md: string): string {
  return md.replace(/```[\s\S]*?```/g, "");
}

function links(md: string): string[] {
  return [...prose(md).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] as string);
}

/** GitHub 的标题 slug：小写、去标点，每个空格变一个 -，中文原样保留 */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*~]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function headingsOf(file: string): Set<string> {
  const headings = new Set<string>();
  for (const line of prose(readFileSync(file, "utf8")).split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (m) headings.add(slug(m[1] as string));
  }
  return headings;
}

const docs = readdirSync(ROOT, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".md") && !f.split("/").some((part) => part === "node_modules" || part === ".pisa"))
  .map((f) => join(ROOT, f));

describe("文档链接可用", () => {
  test("相对路径都指向真实文件", () => {
    const missing = docs.flatMap((file) => {
      const dir = join(file, "..");
      return links(readFileSync(file, "utf8"))
        .filter((l) => !/^(?:https?:|mailto:|#)/.test(l) && !l.includes("://"))
        .map((l) => decodeURI(l.split("#")[0] as string))
        .filter((p) => p && !existsSync(join(dir, p)))
        .map((p) => `${relative(ROOT, file)} -> ${p}`);
    });
    expect(missing).toEqual([]);
  });

  test("页内锚点落在标题上", () => {
    const broken = docs.flatMap((file) => {
      const headings = headingsOf(file);
      return links(readFileSync(file, "utf8"))
        .filter((l) => l.startsWith("#"))
        .map((l) => decodeURI(l.slice(1)))
        .filter((anchor) => !headings.has(anchor))
        .map((anchor) => `${relative(ROOT, file)} -> #${anchor}`);
    });
    expect(broken).toEqual([]);
  });

  test("跨文件锚点落在目标标题上", () => {
    const broken = docs.flatMap((file) => {
      const dir = join(file, "..");
      return links(readFileSync(file, "utf8"))
        .filter((l) => !/^(?:https?:|mailto:|#)/.test(l) && l.includes("#") && !l.includes("://"))
        .flatMap((l) => {
          const [path, anchor] = l.split("#") as [string, string];
          const target = join(dir, decodeURI(path));
          if (!path || !target.endsWith(".md") || !existsSync(target)) return [];
          const has = headingsOf(target).has(decodeURI(anchor));
          return has ? [] : [`${relative(ROOT, file)} -> ${l}`];
        });
    });
    expect(broken).toEqual([]);
  });
});
