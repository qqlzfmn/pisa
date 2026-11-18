import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * token 的两种来源：环境变量优先，缺省读 `~/.pisa/<约定名>`。
 * 与 `scripts/tokens.sh` 同一约定；新增通道时两边一起改。
 */
const TOKEN_FILES: Record<string, string> = {
  PISA_TELEGRAM_TOKEN: "telegram_token",
  PISA_WEBHOOK_TOKEN: "webhook_token",
  PISA_WEB_TOKEN: "web_token",
};

/** 按约定取 token；两处都没有时返回 null */
export function resolveToken(
  envName: string,
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string | null {
  const fromEnv = env[envName]?.trim();
  if (fromEnv) return fromEnv;
  const file = TOKEN_FILES[envName];
  if (!file) return null;
  try {
    return readFileSync(join(home, ".pisa", file), "utf8").trim() || null;
  } catch {
    return null;
  }
}
