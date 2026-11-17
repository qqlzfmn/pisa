import { describe, expect, test } from "bun:test";
import { clip } from "../src/text";

describe("clip", () => {
  test("不超长时原样返回，去掉首尾空白", () => {
    expect(clip("  改好了  ", 10)).toBe("改好了");
  });

  test("超长时保留首尾，结论段不被切掉", () => {
    const body = `开头：改了 out.txt\n${"x".repeat(2000)}\n结论：bun test 130 通过`;
    const out = clip(body, 300);
    expect(out.length).toBe(300);
    expect(out.startsWith("开头：改了 out.txt")).toBe(true);
    expect(out.endsWith("结论：bun test 130 通过")).toBe(true);
    expect(out).toContain("…");
  });

  test("上限小于省略标记时退化为纯截断", () => {
    expect(clip("abcdef", 2)).toBe("ab");
  });
});
