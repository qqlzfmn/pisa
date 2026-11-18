import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 仓库工程化外观：CI 的强制面、模板的必填面、贡献与安全文档的可执行性、CHANGELOG 与版本号同源。 */

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const CI = ".github/workflows/ci.yml";
const BUG = ".github/ISSUE_TEMPLATE/bug_report.yml";
const FEATURE = ".github/ISSUE_TEMPLATE/feature_request.yml";
const ISSUE_CONFIG = ".github/ISSUE_TEMPLATE/config.yml";
const PR = ".github/pull_request_template.md";

describe("CI", () => {
  const yml = read(CI);

  test("push 到 main 与任意 PR 都触发", () => {
    expect(yml).toMatch(/^on:\s*$/m);
    expect(yml).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
    expect(yml).toMatch(/^ {2}pull_request:\s*$/m);
  });

  test("依次安装依赖、跑测试、跑类型检查", () => {
    const step = (cmd: string) => new RegExp(`^ +run: ${cmd}$`, "m");
    const install = yml.search(step("bun install --frozen-lockfile"));
    const testRun = yml.search(step("bun test"));
    const typecheck = yml.search(step("bunx tsc --noEmit"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(testRun).toBeGreaterThan(install);
    expect(typecheck).toBeGreaterThan(testRun);
  });

  test("bun 版本固定，不在运行侧浮动", () => {
    expect(yml).toMatch(/bun-version: \d+\.\d+\.\d+/);
  });

  test("README 的 CI 徽章指向真实存在的工作流", () => {
    const badge = /\/actions\/workflows\/([\w.-]+)\/badge\.svg/.exec(read("README.md"));
    const workflow = badge?.[1] ?? "";
    expect(workflow).not.toBe("");
    expect(existsSync(join(ROOT, ".github/workflows", workflow))).toBe(true);
  });

  test("徽章点击进入同一工作流的 Actions 页面", () => {
    const readme = read("README.md");
    const image = /!\[CI\]\((\S+?)\/badge\.svg\)/.exec(readme);
    const url = image?.[1] ?? "";
    expect(url).not.toBe("");
    expect(readme).toContain(`](${url})`);
  });
});

describe("Issue 表单", () => {
  test("bug 表单覆盖复现所需字段且必填", () => {
    const bug = read(BUG);
    for (const label of ["现象", "期望行为", "复现步骤", "版本", "触发通道", "环境"]) {
      expect(bug).toContain(`label: ${label}`);
    }
    expect((bug.match(/required: true/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });

  test("feature 表单要求可验证的验收标准", () => {
    const feature = read(FEATURE);
    expect(feature).toContain("label: 需求");
    expect(feature).toContain("label: 验收标准");
  });

  test("关闭空白 Issue", () => {
    expect(read(ISSUE_CONFIG)).toContain("blank_issues_enabled: false");
  });
});

describe("PR 模板", () => {
  const pr = read(PR);

  test("要求写回滚方式", () => {
    expect(pr).toContain("回滚方式");
    expect(pr).toContain("影响与风险");
  });

  test("要求两条验证命令", () => {
    expect(pr).toContain("`bun test` 通过");
    expect(pr).toContain("`bunx tsc --noEmit` 通过");
  });
});

describe("贡献与安全文档", () => {
  test("CONTRIBUTING 给出可执行的流程与提交规范", () => {
    const doc = read("CONTRIBUTING.md");
    for (const needle of ["bun test", "bunx tsc --noEmit", "docs/specs/", "Conventional Commits", "AGENTS.md"]) {
      expect(doc).toContain(needle);
    }
  });

  test("SECURITY 声明信任边界、指向能力边界、给出私有上报路径", () => {
    const doc = read("SECURITY.md");
    expect(doc).toContain("信任边界");
    expect(doc).toContain("./docs/usage.md");
    expect(doc).toContain("不要开公开 Issue");
    expect(doc).toContain("Report a vulnerability");
  });
});

describe("CHANGELOG", () => {
  const changelog = read("CHANGELOG.md");
  const pkg = JSON.parse(read("package.json")) as { version: string };
  const version = pkg.version;

  test("保留 Unreleased 段", () => {
    expect(changelog).toContain("## [Unreleased]");
  });

  test("当前版本号有条目", () => {
    expect(changelog).toContain(`## [${version}]`);
  });
});

describe("文档链接", () => {
  const docs = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"];

  test("相对链接都指向真实文件", () => {
    const broken: string[] = [];
    for (const doc of docs) {
      const base = dirname(join(ROOT, doc));
      for (const [, target] of read(doc).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (!target || target.startsWith("#") || /^[a-z]+:/i.test(target)) continue;
        const path = target.split("#")[0];
        if (!path) continue;
        if (!existsSync(resolve(base, path))) broken.push(`${doc} → ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
