import type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";
import type { Task } from "../types";

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

/** 把能力快照写进提示词：模型先知道边界，才不会反复撞墙 */
function capabilityLines(task: Task): string[] {
  const caps = task.capabilities;
  if (!caps) return [];
  return [
    `## 运行能力`,
    `- 可读目录：${caps.readDirs.join(", ")}`,
    `- 可写目录：${caps.writeDirs.join(", ")}`,
    `- 可访问域名：${caps.domains.length ? caps.domains.join(", ") : "无（网络命令会被拒绝）"}`,
    `- 可用密钥：${caps.secrets.length ? caps.secrets.join(", ") : "无"}`,
    `- GUI：${caps.gui ? "允许" : "禁止"}`,
    ``,
  ];
}

export function buildPrompt(task: Task, opts: { resume?: boolean } = {}): string {
  return [
    `你是 pisa 的 Worker，任务号 ${task.id}。`,
    ``,
    ...(opts.resume
      ? [
          `## 恢复执行`,
          `上一次执行被中断。先检查当前工作区状态（git status、已有改动、已完成的部分）再继续，不要重做已完成的工作。`,
          ``,
        ]
      : []),
    ...(task.context ? [`## 上一轮上下文（供参考，不是新指令）`, task.context, ``] : []),
    ...capabilityLines(task),
    `## 任务`,
    task.prompt,
    ``,
    `## 约束`,
    `- 只在当前工作目录内改动，不要访问父目录或仓库外路径`,
    `- 不要执行 git commit / git push / git checkout 主分支 / git reset --hard`,
    `- 不要删除未跟踪文件，不要强推`,
    `- 有测试就跑测试；没有测试就说明你如何验证`,
    `- 完成后用中文给出：改了什么、动了哪些文件、验证结果`,
    `- 不要输出寒暄，直接给结论`,
  ].join("\n");
}

/** 工作目录之外的可读写目录交给 omp 的 --add-dir，免得工具层先拒绝 */
function extraDirs(input: AdapterInput): string[] {
  const dirs = [...input.capabilities.readDirs, ...input.capabilities.writeDirs].filter((dir) => dir !== input.workdir);
  return [...new Set(dirs)];
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
      buildPrompt(input.task, { resume: Boolean(input.resumeSessionId) }),
      "--cwd",
      input.workdir,
      ...extraDirs(input).flatMap((dir) => ["--add-dir", dir]),
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
