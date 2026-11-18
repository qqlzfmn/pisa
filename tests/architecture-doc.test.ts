import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED, type TaskStatus } from "../src/types";

const ROOT = join(import.meta.dir, "..");
const DOC = join(ROOT, "docs/architecture.md");
const doc = readFileSync(DOC, "utf8");

/** 文档里两个「与代码同源」的事实：状态跃迁表与文件路径。任一漂移，维护者改了代码没改文档。 */

function tableEdges(): Set<string> {
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.trim() === "| 从 | 到 | 触发者 | 入口 |");
  expect(start).toBeGreaterThanOrEqual(0);
  const edges = new Set<string>();
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const from = cells[0]?.replace(/`/g, "") ?? "";
    const to = cells[1]?.replace(/`/g, "") ?? "";
    if (!from || from === "—") continue;
    for (const f of from.split("/")) edges.add(`${f}->${to}`);
  }
  return edges;
}

function allowedEdges(): Set<string> {
  const edges = new Set<string>();
  for (const [from, tos] of Object.entries(ALLOWED) as [TaskStatus, TaskStatus[]][]) {
    for (const to of tos) edges.add(`${from}->${to}`);
  }
  return edges;
}

describe("docs/architecture.md 与代码一致", () => {
  test("跃迁表等于 ALLOWED", () => {
    expect([...tableEdges()].sort()).toEqual([...allowedEdges()].sort());
  });

  test("引用的仓库路径都存在", () => {
    const refs = new Set(
      [...doc.matchAll(/`((?:src|extensions|scripts|docs)\/[^`\s]+)`/g)].map((m) => m[1] as string),
    );
    expect(refs.size).toBeGreaterThan(10);
    const missing = [...refs].filter((p) => !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });
});
