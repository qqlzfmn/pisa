import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 三份上手文档的价值在于可执行：术语能对上代码，退出码能对上实现，
 * 命令能原样粘进终端。措辞会变，这里只守这些结构。
 */

const ROOT = join(import.meta.dir, "..");
const COOKBOOK = ["docs/domain.md", "docs/deployment.md", "docs/extending.md"] as const;

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function linkedPaths(md: string): string[] {
  return [...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => (m[1] as string).split("#")[0] as string);
}

function bashBlocks(md: string): string[] {
  return [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] as string);
}

describe("docs cookbook 结构", () => {
  test("三份文档存在且与架构文档互链", () => {
    for (const path of COOKBOOK) {
      expect(existsSync(join(ROOT, path))).toBe(true);
      expect(linkedPaths(read(path))).toContain("./architecture.md");
      expect(linkedPaths(read("docs/architecture.md"))).toContain(`./${path.slice("docs/".length)}`);
    }
  });

  test("术语表覆盖领域核心词", () => {
    const md = read("docs/domain.md");
    const terms = [
      "任务（Task）",
      "状态（status）",
      "阶段（stage）",
      "触发身份（Trigger）",
      "来源（Source）",
      "触发适配器（TriggerAdapter）",
      "通道（ChannelAdapter）",
      "| Worker |",
      "Worker 适配器（WorkerAdapter）",
      "交付器（Deliverer）",
      "账本（Effect）",
      "Outbox",
      "对账（reconcile）",
      "撤销（rewind）",
      "保留（retention）",
      "主动发现（proactive）",
    ];
    expect(terms.filter((term) => !md.includes(term))).toEqual([]);
  });

  test("部署文档保留生命周期与排障入口", () => {
    const md = read("docs/deployment.md");
    for (const heading of ["## 2. 首次安装", "## 3. 升级", "## 4. 回滚", "## 5. 退出码", "## 7. 排障表"]) {
      expect(md).toContain(heading);
    }
  });

  test("扩展指南保留两类 Source 与 WorkerAdapter 的测试步骤", () => {
    const md = read("docs/extending.md");
    for (const heading of ["## 3. 加协议型 Source", "## 4. 加常驻型 Source", "## 5. 加 WorkerAdapter"]) {
      expect(md).toContain(heading);
    }
    for (const heading of ["### 3.5 测试", "### 4.3 测试", "### 5.3 测试"]) {
      expect(md).toContain(heading);
    }
  });

  test("文档里的 bash 代码块语法有效", () => {
    const failures: string[] = [];
    for (const path of COOKBOOK) {
      bashBlocks(read(path)).forEach((block, index) => {
        const result = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
        if (result.status !== 0) failures.push(`${path} 第 ${index + 1} 块：${result.stderr.trim()}`);
      });
    }
    expect(failures).toEqual([]);
  });

  test("bun run 的目标都真实存在", () => {
    const scripts = Object.keys(JSON.parse(read("package.json")).scripts ?? {});
    const missing: string[] = [];
    for (const path of COOKBOOK) {
      for (const match of read(path).matchAll(/\bbun run ([^\s|;&)`'"]+)/g)) {
        const target = match[1] as string;
        if (target.startsWith("-") || target.includes("$")) continue;
        if (!scripts.includes(target) && !existsSync(join(ROOT, target))) missing.push(`${path} -> ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("退出码文档与实现一致", () => {
  test("CLI 退出码表覆盖 src/cli.ts 的 EXIT 常量", () => {
    const source = read("src/cli.ts");
    const block = /const EXIT = \{([\s\S]*?)\} as const;/.exec(source)?.[1] ?? "";
    const implemented = [...block.matchAll(/(\w+): (\d+)/g)].map((m) => Number(m[2])).sort();

    const md = read("docs/deployment.md");
    const section = md.slice(md.indexOf("### CLI"), md.indexOf("### 守护进程"));
    const documented = [...section.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1])).sort();

    expect(documented).toEqual(implemented);
  });

  test("守护进程退出码表保留 0 / 1 / 75", () => {
    const md = read("docs/deployment.md");
    const section = md.slice(md.indexOf("### 守护进程"), md.indexOf("## 6. 数据目录"));
    const documented = [...section.matchAll(/^\|\s*(\d+)\s*\|/gm)].map((m) => Number(m[1]));
    expect(documented).toEqual(expect.arrayContaining([0, 1, 75]));
  });
});
