import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { ALLOWED, type TaskStatus } from "../src/types";

const ROOT = join(import.meta.dir, "..");
const DOC = join(ROOT, "docs/architecture.md");
const doc = readFileSync(DOC, "utf8");

/** 文档里「与代码同源」的事实：状态跃迁表、文件路径、分层依赖图。任一漂移，维护者改了代码没改文档。 */

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

function tsFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return tsFiles(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}

/** 相对导入的模块路径（去扩展名）：src/channels/cli.ts 里的 "../types" → "src/types" */
function importsOf(file: string): string[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const dir = posix.dirname(file);
  return [...text.matchAll(/from\s+"(\.[^"]*)"/g)].map((m) =>
    posix.normalize(posix.join(dir, m[1] as string)),
  );
}

const SRC_FILES = tsFiles("src");

function importersOf(module: string): string[] {
  return SRC_FILES.filter((f) =>
    importsOf(f).some((m) => m === module || m.startsWith(`${module}/`)),
  );
}

describe("分层边界由 import 图保证", () => {
  test("index 是唯一装配点，没人导入它", () => {
    expect(importersOf("src/index")).toEqual([]);
  });

  test("只有 index 导入通道实现", () => {
    expect(importersOf("src/channels")).toEqual(["src/index.ts"]);
  });

  test("通道只依赖共享类型，不认识 core", () => {
    const bad = tsFiles("src/channels").flatMap((f) =>
      importsOf(f)
        .filter((m) => m !== "src/types")
        .map((m) => `${f} → ${m}`),
    );
    expect(bad).toEqual([]);
  });

  test("具体 agent 实现只在 adapters 与 worker 内出现", () => {
    const bad = SRC_FILES.filter((f) => !f.startsWith("src/adapters/") && f !== "src/worker.ts")
      .flatMap((f) =>
        importsOf(f)
          .filter((m) => m.startsWith("src/adapters"))
          .map((m) => `${f} → ${m}`),
      );
    expect(bad).toEqual([]);
  });
});
