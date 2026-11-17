import { describe, expect, test } from "bun:test";
import { COMMANDS, parseCommand, type HelpGroup } from "../src/config";
import { EXAMPLES, formatExamples, formatHelp } from "../src/usage";

const GROUPS: readonly HelpGroup[] = ["派活", "查询", "维护", "集成"];

describe("parseCommand · examples", () => {
  test("识别英文命令", () => {
    expect(parseCommand("/pisa examples", "/pisa")).toEqual({ kind: "examples", body: "" });
  });

  test("识别中文别名", () => {
    expect(parseCommand("/pisa 示例", "/pisa")).toEqual({ kind: "examples", body: "" });
  });

  test("忽略多余参数", () => {
    expect(parseCommand("/pisa examples 多余", "/pisa")).toEqual({ kind: "examples", body: "" });
  });
});

describe("EXAMPLES", () => {
  test("场景数量在 6–8 之间", () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(6);
    expect(EXAMPLES.length).toBeLessThanOrEqual(8);
  });

  test("每个场景都有触发方式与预期产出", () => {
    for (const e of EXAMPLES) {
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.trigger.length).toBeGreaterThan(0);
      expect(e.outcome.length).toBeGreaterThan(0);
    }
    expect(EXAMPLES.filter((e) => e.trigger.includes("{trigger}")).length).toBeGreaterThanOrEqual(6);
  });

  test("渲染时替换触发词并标出触发/产出", () => {
    const text = formatExamples("/go");
    expect(text).toContain("docs/usage.md");
    for (const e of EXAMPLES) {
      expect(text).toContain(`${e.title}\n   触发：`);
    }
    expect(text).toContain("/go 修复登录超时");
    expect(text).not.toContain("{trigger}");
  });
});

describe("formatHelp", () => {
  test("按四组输出且顺序固定", () => {
    const lines = formatHelp("/pisa").split("\n");
    const headers = lines.filter((l) => GROUPS.includes(l as HelpGroup));
    expect(headers).toEqual([...GROUPS]);
  });

  test("覆盖 COMMANDS 全部命令", () => {
    const text = formatHelp("/pisa");
    for (const c of COMMANDS) {
      expect(text).toContain(`/pisa ${c.command}`);
    }
  });

  test("命令落在自己声明的分组下", () => {
    const lines = formatHelp("/pisa").split("\n");
    for (const c of COMMANDS) {
      const line = lines.find((l) => l.trimStart().startsWith(`/pisa ${c.command}`));
      expect(line).toBeDefined();
      const before = lines.slice(0, lines.indexOf(line!)).filter((l) => GROUPS.includes(l as HelpGroup));
      expect(before.at(-1)).toBe(c.group);
    }
  });

  test("保留仓库别名入口并指向 usage 文档", () => {
    const text = formatHelp("/pisa");
    expect(text).toContain("/pisa @别名 <需求>");
    expect(text).toContain("docs/usage.md");
  });

  test("使用配置的触发词", () => {
    expect(formatHelp("/go")).toContain("/go examples");
    expect(formatHelp("/go")).not.toContain("/pisa");
  });
});
