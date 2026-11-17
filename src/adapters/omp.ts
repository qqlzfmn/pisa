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

const WORK_CONSTRAINTS = [
  `## 约束`,
  `- 只在当前工作目录内改动，不要访问父目录或仓库外路径`,
  `- 不要执行 git commit / git push / git checkout 主分支 / git reset --hard`,
  `- 不要删除未跟踪文件，不要强推`,
  `- 有测试就跑测试；没有测试就说明你如何验证`,
  `- 完成后用中文给出：改了什么、动了哪些文件、验证结果`,
  `- 不要输出寒暄，直接给结论`,
];

/** 评审任务的约束：工作副本是分离 HEAD、用完丢弃，改动不会被保存 */
const REVIEW_CONSTRAINTS = [
  `## 约束（只读评审）`,
  `- 只读：不要修改工作目录里的任何文件，不要执行 git commit / push / checkout / reset / apply / clean`,
  `- 环境变量 PISA_READONLY=1，pisa 扩展会拦截写文件与 git 提交类命令`,
  `- 工作副本是分离 HEAD，评审结束会被删除；在里面改的文件不会被保存，也不会交付`,
  `- 只做代码阅读与必要的只读命令，不安装依赖、不跑长时间任务`,
  `- 结论用中文 Markdown：先给结论，再按严重程度列问题（文件与行号、问题、影响、建议），最后列没问题的部分`,
  `- 不要输出寒暄，直接给结论`,
];

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
    `## 任务`,
    task.prompt,
    ``,
    ...(task.mode === "review" ? REVIEW_CONSTRAINTS : WORK_CONSTRAINTS),
  ].join("\n");
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
    ];
  }

  buildEnv(input: AdapterInput): Record<string, string> {
    return {
      PISA_WORKDIR: input.workdir,
      PISA_PROGRESS_FILE: input.progressFile,
      // 评审任务：worker 扩展据此拦截写文件与改写历史的 git 命令
      ...(input.task.mode === "review" ? { PISA_READONLY: "1" } : {}),
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
