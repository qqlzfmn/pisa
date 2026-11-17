import { describe, expect, test } from "bun:test";
import { workerEnv } from "../src/env";

describe("workerEnv", () => {
  test("只放行基础变量，凭据与 pisa 配置不传", () => {
    const before = { token: process.env.GH_TOKEN, telegram: process.env.PISA_TELEGRAM_TOKEN };
    process.env.GH_TOKEN = "ghp_secret";
    process.env.PISA_TELEGRAM_TOKEN = "telegram_secret";
    try {
      const env = workerEnv();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.PISA_TELEGRAM_TOKEN).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      restore("GH_TOKEN", before.token);
      restore("PISA_TELEGRAM_TOKEN", before.telegram);
    }
  });

  test("显式追加的变量覆盖同名基础变量", () => {
    expect(workerEnv({ LANG: "C", CI: "1" })).toMatchObject({ LANG: "C", CI: "1" });
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
