import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DOCS = ["docs/architecture.md", "docs/domain.md", "docs/deployment.md", "docs/extending.md"];
const PAGES = ["README.md", ...DOCS];
const CACHE = new Map<string, string>();

function readPage(page: string): string {
  const cached = CACHE.get(page);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(ROOT, page), "utf8");
  CACHE.set(page, text);
  return text;
}

/** 去掉围栏代码，避免把示例里的方括号当成链接 */
function withoutFences(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out.join("\n");
}

function links(markdown: string): string[] {
  return [...withoutFences(markdown).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]!.trim());
}

describe("文档契约", () => {
  test("四篇文档存在且有内容", () => {
    for (const page of PAGES) {
      expect(existsSync(join(ROOT, page))).toBe(true);
      expect(readPage(page).length).toBeGreaterThan(500);
    }
  });

  test("相对链接都能解析到文件或目录", () => {
    const broken: string[] = [];
    for (const page of PAGES) {
      for (const href of links(readPage(page))) {
        if (/^(https?:|mailto:|#)/.test(href)) continue;
        if (href.startsWith("/")) continue;
        const clean = href.split("#")[0]!.split("?")[0]!;
        if (!clean) continue;
        const target = resolve(dirname(join(ROOT, page)), clean);
        if (!existsSync(target)) broken.push(`${page} -> ${href}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("四篇文档互相链接到架构页", () => {
    const expected: Record<string, string[]> = {
      "docs/architecture.md": ["./domain.md", "./deployment.md", "./extending.md"],
      "docs/domain.md": ["./architecture.md", "./deployment.md", "./extending.md"],
      "docs/deployment.md": ["./architecture.md", "./domain.md", "./extending.md"],
      "docs/extending.md": ["./architecture.md", "./domain.md", "./deployment.md"],
    };
    const missing: string[] = [];
    for (const [page, targets] of Object.entries(expected)) {
      const present = new Set(links(readPage(page)).map((href) => href.split("#")[0]));
      for (const target of targets) {
        if (!present.has(target)) missing.push(`${page} -> ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("README 链接到四篇文档", () => {
    const present = new Set(links(readPage("README.md")));
    const missing = DOCS.filter((page) => !present.has(page));
    expect(missing).toEqual([]);
  });

  test("bash 代码块通过 bash -n", () => {
    const blocks: Array<{ page: string; index: number; code: string }> = [];
    for (const page of PAGES) {
      const pattern = /```bash\n([\s\S]*?)```/g;
      let match: RegExpExecArray | null;
      let index = 0;
      while ((match = pattern.exec(readPage(page))) !== null) {
        blocks.push({ page, index: ++index, code: match[1]! });
      }
    }
    expect(blocks.length).toBeGreaterThan(0);

    const dir = mkdtempSync(join(tmpdir(), "pisa-docs-bash-"));
    const failures: string[] = [];
    try {
      for (const block of blocks) {
        const file = join(dir, `${block.page.replace(/[^a-z0-9]+/gi, "_")}-${block.index}.sh`);
        writeFileSync(file, block.code, "utf8");
        const result = spawnSync("bash", ["-n", file], { encoding: "utf8" });
        if (result.status !== 0) {
          failures.push(`${block.page} 第 ${block.index} 个 bash 块：${result.stderr.trim()}`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(failures).toEqual([]);
  });
});
