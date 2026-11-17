// @ts-nocheck
// pisa Worker 扩展：把 pi 生命周期事件写给 Router，并在 agent 内部执行策略。
// 由 Router 通过 `omp -e extensions/pisa-worker.ts` 挂载。

import { appendFileSync } from "node:fs";

const FILE = process.env.PISA_PROGRESS_FILE;
const WORKDIR = process.env.PISA_WORKDIR ?? "";

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
      emit({ type: "tool", tool: "bash", detail: bashDetail(cmd) });
      return;
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
