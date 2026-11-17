import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrompts } from "../src/prompts";

/**
 * 测试共用：把仓库里的内置层复制到临时目录再装载。
 * 直接读 prompts/ 会带上开发者本地的 team.json，用例结果随配置漂移。
 */
const dir = mkdtempSync(join(tmpdir(), "pisa-prompts-"));
copyFileSync(join(import.meta.dir, "..", "prompts", "builtin.json"), join(dir, "builtin.json"));
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));

export const PROMPTS = loadPrompts(dir);
