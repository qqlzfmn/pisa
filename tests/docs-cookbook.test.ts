import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT } from "../src/cli";
import { ADAPTERS, getAdapter } from "../src/adapters";

const ROOT = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
/** 去掉围栏代码块：示例命令不是链接，也不参与互链断言 */
const withoutCode = (path: string) => read(path).replace(/```[\s\S]*?```/g, "");

/** 表头行之后的连续表格行，返回去掉首尾竖线后的单元格 */
function tableAfter(md: string, headerRow: string): string[][] {
  const at = md.indexOf(headerRow);
  if (at === -1) throw new Error(`找不到表头：${headerRow}`);
  const rows: string[][] = [];
  for (const line of md.slice(at).split("\n").slice(2)) {
    if (!line.trim().startsWith("|")) break;
    rows.push(line.split("|").slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
}

const COOKBOOK = ["docs/domain.md", "docs/deployment.md", "docs/extending.md"];

describe("文档食谱", () => {
  test("退出码表与 EXIT 一致，并覆盖守护进程的 75", () => {
    const rows = tableAfter(read("docs/deployment.md"), "| 进程 | 退出码 |");
    const cliCodes = rows
      .filter(([process]) => process!.replace(/`/g, "") === "pisa CLI")
      .map(([, code]) => Number(code!.replace(/`/g, "")));
    expect(cliCodes.sort()).toEqual(Object.values(EXIT).sort());
    expect(rows.some(([process, code]) => process === "`守护进程`" && code === "`75`")).toBe(true);
  });

  test("适配器清单与注册表一致", () => {
    const names = tableAfter(read("docs/extending.md"), "| worker.adapter | 实现 |").map(([name]) =>
      name!.replace(/`/g, ""),
    );
    expect(names.sort()).toEqual([...ADAPTERS].sort());
    for (const name of names) expect(getAdapter(name).name).toBe(name);
  });

  test("术语表引用的代码路径都存在", () => {
    const refs = new Set([...read("docs/domain.md").matchAll(/`((?:src|extensions|scripts)\/[^`\s]+)`/g)].map((m) => m[1]!));
    expect(refs.size).toBeGreaterThan(10);
    const missing = [...refs].filter((ref) => !existsSync(join(ROOT, ref)));
    expect(missing).toEqual([]);
  });

  test("architecture 与三篇文档双向互链", () => {
    for (const path of COOKBOOK) {
      if (!withoutCode(path).includes("](./architecture.md)")) throw new Error(`${path} 没有链回 architecture`);
    }
    const arch = withoutCode("docs/architecture.md");
    for (const path of COOKBOOK) expect(arch).toContain(`](./${path.slice("docs/".length)})`);
  });

  test("顶层文档的 bash 代码块都能通过语法检查", () => {
    const files = [
      "README.md",
      "CONTRIBUTING.md",
      "SDD.md",
      ...readdirSync(join(ROOT, "docs"))
        .filter((name) => name.endsWith(".md"))
        .map((name) => `docs/${name}`),
    ];
    let checked = 0;
    for (const path of files) {
      for (const [index, block] of [...read(path).matchAll(/```bash\n([\s\S]*?)```/g)].entries()) {
        checked += 1;
        const result = Bun.spawnSync({
          cmd: ["bash", "-n"],
          stdin: new TextEncoder().encode(block[1]!),
          stdout: "pipe",
          stderr: "pipe",
        });
        if (result.exitCode !== 0) {
          throw new Error(`${path} 第 ${index + 1} 个 bash 块语法错误：${result.stderr.toString()}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  test("部署与扩展两篇都带可复制的命令块", () => {
    for (const path of ["docs/deployment.md", "docs/extending.md"]) {
      expect(read(path)).toMatch(/```bash\n[\s\S]+?```/);
    }
  });
});
