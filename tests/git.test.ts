import { describe, expect, test } from "bun:test";
import { sh } from "../src/git";

describe("sh", () => {
  test("env 覆盖子进程环境", () => {
    const r = sh(["sh", "-c", 'printf %s "${VERIFY_ONLY:-missing}${GH_TOKEN:+-leak}"'], undefined, {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", VERIFY_ONLY: "yes" },
    });
    expect(r.out).toBe("yes");
  });

  test("timeoutMs 到点强杀并标记 timedOut", () => {
    const t0 = Date.now();
    const r = sh(["sh", "-c", "sleep 5"], undefined, { timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(-1);
  });

  test("正常退出不标记超时", () => {
    expect(sh(["sh", "-c", "exit 0"]).timedOut).toBe(false);
  });
});
