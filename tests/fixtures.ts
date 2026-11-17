import { join } from "node:path";
import { loadPrompts } from "../src/prompts";

/** 测试共用：装载仓库自带的提示词分层 */
export const PROMPTS = loadPrompts(join(import.meta.dir, "..", "prompts"));
