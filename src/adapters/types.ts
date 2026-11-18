import type { Config } from "../config";
import type { PromptLibrary } from "../prompts";
import type { Task } from "../types";

export interface AdapterInput {
  task: Task;
  workdir: string;
  extensionPath: string;
  progressFile: string;
  cfg: Config["worker"];
  /** 是否恢复中断任务；决定提示词是否带核对段落，与会话 id 是否存在无关 */
  resume?: boolean;
  /** 恢复中断任务时的原会话 id；新任务为 null */
  resumeSessionId?: string | null;
  /** 提示词覆盖；缺省只用内置段落 */
  prompts?: PromptLibrary;
}

export interface ParsedLine {
  /** 完整助手消息（只在 message_end 出现） */
  text?: string;
  /** 无法解析时保留的原始行 */
  raw?: string;
}

/**
 * Worker 适配器：把「怎么调用一个 agent」和「怎么读它的输出」从调度逻辑里拆出来。
 * 换 agent 只需实现这个接口，Router 不需要改。
 */
export interface WorkerAdapter {
  name: string;
  buildArgs(input: AdapterInput): string[];
  buildEnv(input: AdapterInput): Record<string, string>;
  parseLine(line: string): ParsedLine;
}
