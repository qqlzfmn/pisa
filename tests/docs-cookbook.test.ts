import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../src/cli";

/**
 * 手册与代码的契约：退出码、适配器接口、被引用的仓库路径、互链、launchd 标签、命令块语法。
 * 只校验可机械判定的事实，不比对叙述文字。
 */

const ROOT = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

describe("部署手册与 CLI 退出码一致", () => {
  test("CLI 表覆盖 EXIT 的每个值且名称相同", () => {
    const section = read("docs/deployment.md").split("### CLI（")[1]?.split("### 守护进程")[0] ?? "";
    const rows = [...section.matchAll(/^\|\s*`(\d+)`\s*\|\s*`([A-Za-z]+)`\s*\|/gm)].map((m) => [
      Number(m[1]),
      m[2] as string,
    ]);
    expect(rows).toEqual(Object.entries(EXIT).map(([name, code]) => [code, name]));
  });

  test("守护进程退出码含 0、1、75", () => {
    const section = read("docs/deployment.md").split("### 守护进程")[1]?.split("### HTTP")[0] ?? "";
    for (const code of ["0", "1", "75"]) expect(section).toContain(`| \`${code}\` |`);
    expect(read("src/index.ts")).toContain("process.exit(75)");
  });
});

describe("扩展指南与适配器接口一致", () => {
  test("文档里的 WorkerAdapter 成员等于 types.ts", () => {
    const source = /export interface WorkerAdapter \{([\s\S]*?)\n\}/.exec(read("src/adapters/types.ts"))?.[1] ?? "";
    const docBlock = /```ts\n(export interface WorkerAdapter \{[\s\S]*?\n\})\n```/.exec(
      read("docs/extending.md"),
    )?.[1] ?? "";
    const member = /^\s+(\w+)\??\s*[:(]/gm;
    expect([...docBlock.matchAll(member)].map((m) => m[1] as string)).toEqual(
      [...source.matchAll(member)].map((m) => m[1] as string),
    );
    expect([...source.matchAll(member)].map((m) => m[1] as string)).toEqual([
      "name",
      "buildArgs",
      "buildEnv",
      "parseLine",
    ]);
  });
});

describe("手册引用真实存在", () => {
  test("src/ tests/ scripts/ extensions/ skills/ 下的路径都存在", () => {
    const files = ["docs/domain.md", "docs/deployment.md", "docs/extending.md"];
    // 扩展指南里的示例文件由读者创建，不要求当前仓库已存在
    const planned: Record<string, true> = { "src/adapters/myagent.ts": true, "src/rss-source.ts": true };
    const missing = files.flatMap((file) =>
      [...read(file).matchAll(/`((?:src|tests|scripts|extensions|skills)\/[^`\s]*)`/g)]
        .map((m) => m[1] as string)
        .filter((path) => !path.includes("<") && !(path in planned) && !existsSync(join(ROOT, path)))
        .map((path) => `${file} -> ${path}`),
    );
    expect(missing).toEqual([]);
  });

  test("三份新文档回链架构，架构页链回三份文档", () => {
    for (const file of ["docs/domain.md", "docs/deployment.md", "docs/extending.md"]) {
      expect(read(file)).toContain("](./architecture.md");
    }
    const architecture = read("docs/architecture.md");
    for (const file of ["domain.md", "deployment.md", "extending.md"]) {
      expect(architecture).toContain(`](./${file})`);
    }
  });

  test("launchd 标签与安装脚本一致", () => {
    const label = /^label="([^"]+)"/m.exec(read("scripts/install-launchd.sh"))?.[1];
    expect(label).toBeTruthy();
    expect(read("docs/deployment.md")).toContain(label as string);
  });
});

describe("命令块可解析", () => {
  test("新增的 bash 块通过 bash -n", () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-docs-"));
    try {
      for (const file of ["docs/deployment.md", "docs/extending.md"]) {
        const blocks = [...read(file).matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((m) => m[1] as string);
        expect(blocks.length).toBeGreaterThan(0);
        blocks.forEach((code, i) => {
          const script = join(dir, `block-${i}.sh`);
          writeFileSync(script, code);
          const run = Bun.spawnSync(["bash", "-n", script]);
          expect({ file, block: i, code: run.exitCode, stderr: run.stderr.toString() }).toMatchObject({ code: 0 });
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
