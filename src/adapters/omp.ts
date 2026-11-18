import type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";
import type { Task } from "../types";
import { defaultPrompts, type PromptLibrary } from "../prompts";

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
  return msg.content
    .map((c) =>
      typeof c === "string"
        ? c
        : typeof (c as { text?: string }).text === "string"
          ? (c as { text: string }).text
          : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function buildPrompt(
  task: Task,
  opts: { resume?: boolean; prompts?: PromptLibrary } = {},
): string {
  const prompts = opts.prompts ?? defaultPrompts();
  const repo = task.repo;
  const blocks = [
    prompts.render("worker.title", { taskId: task.id }, repo),
    ...(opts.resume ? [prompts.render("worker.resume", {}, repo)] : []),
    ...(task.context ? [prompts.render("worker.context", { context: task.context }, repo)] : []),
    prompts.render("worker.task", { prompt: task.prompt }, repo),
    prompts.render("worker.constraints", {}, repo),
    prompts.render("worker.review", {}, repo),
  ];
  return blocks.join("\n\n");
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
      buildPrompt(input.task, { resume: Boolean(input.resume), prompts: input.prompts }),
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
