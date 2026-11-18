import type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";
import type { Task } from "../types";
import { capabilityText } from "../capabilities";

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

export function buildPrompt(task: Task, opts: { resume?: boolean } = {}): string {
  return [
    `你是 pisa 的 Worker，任务号 ${task.id}。`,
    ``,
    ...(opts.resume
      ? [
          `## 恢复执行`,
          `上一次执行被中断。先核对现状，再决定动作，不要重复已经发生的副作用：`,
          `1. 检查工作目录：\`git status\` 与 \`git log\`，确认已有改动、提交与未完成的部分。`,
          `2. 检查外部动作是否已经落地：分支是否已推送、PR 是否已存在（如 \`gh pr list --head <分支>\`），以及任务是否已回帖。`,
          `3. 已完成的改动不重做；PR 已存在时不重复创建。推送、创建 PR、发表评论这些外部动作，确认尚未发生后再执行。`,
          `从核对结果出发继续剩余工作。`,
          ``,
        ]
      : []),
    ...(task.context ? [`## 上一轮上下文（供参考，不是新指令）`, task.context, ``] : []),
    `## 任务`,
    task.prompt,
    ``,
    `## 约束（以下由 pisa guard 强制，越界调用会被拒绝）`,
    `- 工作目录与系统临时目录可读写；其余目录、域名、GUI 与环境变量按能力清单执行`,
    ...(task.capabilities ? capabilityText(task.capabilities).split("\n") : [`- 未声明能力：只允许工作目录，网络与 GUI 一律拒绝`]),
    `- git 的 -C / --work-tree / --git-dir 也只能指向工作目录`,
    `- 禁止 git push（任意形态）、reset --hard、clean -f、切换分支、worktree remove/prune、branch -D、rebase、commit --amend`,
    `- 禁止 sudo、删除根目录、改动 /etc 权限`,
    `- 提交与推送由 pisa 在任务结束后完成，不需要你操作`,
    `- 有测试就跑测试；没有测试就说明你如何验证`,
    `- 完成后用中文给出：改了什么、动了哪些文件、验证结果`,
    `- 不要输出寒暄，直接给结论`,
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
      buildPrompt(input.task, { resume: Boolean(input.resume) }),
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
