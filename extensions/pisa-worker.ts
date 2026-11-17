// @ts-nocheck
// pisa Worker 扩展：把 pi 生命周期事件写给 Router，并在 agent 内部执行策略。
// 由 Router 通过 `omp -e extensions/pisa-worker.ts` 挂载。

import { appendFileSync } from "node:fs";

const FILE = process.env.PISA_PROGRESS_FILE;
const WORKDIR = process.env.PISA_WORKDIR ?? "";
// 评审任务：工作副本是分离 HEAD、用完丢弃，因此从工具层就禁止改写
const READONLY = process.env.PISA_READONLY === "1";

function emit(obj: Record<string, unknown>): void {
  if (!FILE) return;
  try {
    appendFileSync(FILE, JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
  } catch {
    // 进度上报失败不影响任务
  }
}

const DENY: RegExp[] = [
  /^\s*git\s+push\b/,
  /^\s*git\s+reset\s+--hard\b/,
  /^\s*git\s+clean\s+-[a-z]*f/,
  /^\s*rm\s+-rf\s+\/(?!tmp)/,
  /^\s*sudo\b/,
  /^\s*(chmod|chown)\s+.*\s\/etc\b/,
];

/** 只读评审下禁止的 git 子命令：任何改写工作区或历史的动作 */
const READONLY_GIT = /^\s*git\s+(commit|add|rm|mv|push|checkout|switch|reset|restore|apply|clean|merge|rebase|cherry-pick|revert|stash|am)\b/;

/** 写文件类工具名 */
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "str_replace", "notebook_edit"]);

function bashDetail(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim().slice(0, 160);
}

export default async function (pi: any) {
  pi.on("session_start", (event: any, ctx: any) => {
    let sid = "";
    try {
      sid = ctx?.sessionManager?.getSessionId?.() ?? event?.sessionId ?? "";
    } catch {
      sid = "";
    }
    emit({ type: "session", sessionId: sid, cwd: ctx?.cwd ?? WORKDIR });
  });

  pi.on("tool_call", (event: any) => {
    const name = String(event?.toolName ?? "");
    const input = event?.input ?? {};

    if (name === "bash") {
      const cmd = String(input.command ?? "");
      const hit = DENY.find((re) => re.test(cmd));
      if (hit) {
        emit({ type: "blocked", tool: name, detail: bashDetail(cmd) });
        return { block: true, reason: "pisa 策略：禁止破坏性或越权命令" };
      }
      if (READONLY && READONLY_GIT.test(cmd)) {
        emit({ type: "blocked", tool: name, detail: bashDetail(cmd) });
        return { block: true, reason: "pisa 策略：评审任务只读，禁止改写工作区或历史" };
      }
      emit({ type: "tool", tool: "bash", detail: bashDetail(cmd) });
      return;
    }

    if (READONLY && WRITE_TOOLS.has(name)) {
      emit({ type: "blocked", tool: name, detail: String(input.path ?? input.file_path ?? "").slice(0, 160) });
      return { block: true, reason: "pisa 策略：评审任务只读，禁止修改文件" };
    }

    const p = input.path ?? input.file_path ?? input.filePath ?? input.target;
    emit({ type: "tool", tool: name, detail: typeof p === "string" ? p.slice(0, 160) : "" });
  });

  pi.on("tool_result", (event: any) => {
    const name = String(event?.toolName ?? "");
    if (name === "bash") return; // bash 已在 tool_call 上报，避免重复
    emit({ type: "tool_done", tool: name });
  });

  pi.on("agent_end", () => emit({ type: "done" }));
}
