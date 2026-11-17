// @ts-nocheck
// pisa Worker 扩展：把 pi 生命周期事件写给 Router，并执行任务的能力策略。
// 由 Router 通过 `omp -e extensions/pisa-worker.ts` 挂载；策略来自 PISA_CAPABILITIES。

import { appendFileSync } from "node:fs";
import { checkToolCall, resolveCapabilities, type ResolvedCapabilities } from "../src/capabilities";

interface ToolCallEvent {
  toolName?: string;
  input?: Record<string, unknown>;
}

interface SessionEvent {
  sessionId?: string;
}

interface SessionContext {
  cwd?: string;
  sessionManager?: { getSessionId?: () => string };
}

interface ExtensionApi {
  on(event: "session_start", handler: (event: SessionEvent, ctx: SessionContext) => void): void;
  on(event: "tool_call", handler: (event: ToolCallEvent) => { block: true; reason: string } | undefined): void;
  on(event: "tool_result", handler: (event: ToolCallEvent) => void): void;
  on(event: "agent_end", handler: () => void): void;
}

// env 在每次调用时读取：Worker 每次启动都重新下发，模块只在首次加载
function emit(obj: Record<string, unknown>): void {
  const file = process.env.PISA_PROGRESS_FILE;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
  } catch {
    // 进度上报失败不影响任务
  }
}

/** 策略随 env 下发；缺失或损坏时退到默认拒绝，而不是放行 */
function policy(): ResolvedCapabilities {
  const raw = process.env.PISA_CAPABILITIES;
  if (raw) {
    try {
      // 由 pisa 自己写入的 env，形状由 ResolvedCapabilities 保证
      return JSON.parse(raw) as ResolvedCapabilities;
    } catch {
      // 落到下面的默认拒绝
    }
  }
  return resolveCapabilities(undefined, process.env.PISA_WORKDIR ?? "");
}

function detailOf(tool: string, input: Record<string, unknown>): string {
  if (tool === "bash") return String(input.command ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  const p = input.path ?? input.file_path ?? input.filePath ?? input.target;
  return typeof p === "string" ? p.slice(0, 160) : "";
}

export default async function (pi: ExtensionApi) {
  const caps = policy();

  pi.on("session_start", (event, ctx) => {
    let sid = "";
    try {
      sid = ctx?.sessionManager?.getSessionId?.() ?? event?.sessionId ?? "";
    } catch {
      sid = "";
    }
    emit({ type: "session", sessionId: sid, cwd: ctx?.cwd ?? process.env.PISA_WORKDIR ?? "" });
  });

  pi.on("tool_call", (event) => {
    const name = String(event?.toolName ?? "");
    const input = event?.input ?? {};
    const verdict = checkToolCall(caps, name, input);
    if (!verdict.allow) {
      emit({ type: "blocked", tool: name, reason: verdict.reason, detail: verdict.detail || detailOf(name, input) });
      return { block: true, reason: verdict.reason };
    }
    emit({ type: "tool", tool: name, detail: detailOf(name, input) });
    return;
  });

  pi.on("tool_result", (event) => {
    const name = String(event?.toolName ?? "");
    if (name === "bash") return; // bash 已在 tool_call 上报，避免重复
    emit({ type: "tool_done", tool: name });
  });

  pi.on("agent_end", () => emit({ type: "done" }));
}
