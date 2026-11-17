import type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";
import { renderPrompt } from "../prompts";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

interface JsonEvent {
  type?: string;
  message?: { role?: string; content?: unknown };
}

/** 只取 assistant 的完整消息，避免把用户提示词与 delta 混进摘要 */
function assistantText(obj: JsonEvent): string {
  if (obj.type !== "message_end") return "";
  const msg = obj.message;
  if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return "";
  const textOf = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (content !== null && typeof content === "object" && "text" in content && typeof content.text === "string") {
      return content.text;
    }
    return "";
  };
  return msg.content.map(textOf).filter(Boolean).join("\n").trim();
}

/** omp（Oh My Pi）适配器 */
export class OmpAdapter implements WorkerAdapter {
  name = "omp";

  buildArgs(input: AdapterInput): string[] {
    return [
      input.cfg.command,
      ...input.cfg.extraArgs,
      "-e",
      input.extensionPath,
      ...(input.resumeSessionId ? ["-r", input.resumeSessionId] : []),
      "--mode=json",
      "-p",
      renderPrompt(input.prompts, input.task, { resume: Boolean(input.resumeSessionId) }),
      "--cwd",
      input.workdir,
    ];
  }

  buildEnv(input: AdapterInput): Record<string, string> {
    return {
      PISA_WORKDIR: input.workdir,
      PISA_PROGRESS_FILE: input.progressFile,
    };
  }

  parseLine(line: string): ParsedLine {
    const clean = line.replace(ANSI, "").trim();
    if (!clean) return {};
    try {
      const obj = JSON.parse(clean) as JsonEvent;
      const text = assistantText(obj);
      return text ? { text } : {};
    } catch {
      return { raw: clean };
    }
  }
}
