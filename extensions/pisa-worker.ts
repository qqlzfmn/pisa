// pisa Worker 扩展：把 pi 生命周期事件写给 Router，并在 agent 内部执行策略。
// 判定逻辑在 guard.ts（纯函数、可单测），这里只做事件接线。
// 由 Router 通过 `omp -e extensions/pisa-worker.ts` 挂载。
//
// 能力清单从 PISA_CAPABILITIES 读；缺失或损坏时按默认全拒：只读写工作目录，不联网，不开 GUI。

import { appendFileSync } from "node:fs";
import { parseManifest } from "../src/capabilities";
import { blockBash, outsideReadable, outsideWritable, type GuardPolicy } from "./guard";

/** 环境变量 → 策略；清单缺失或损坏时按默认全拒 */
export function policyFromEnv(env: NodeJS.ProcessEnv): GuardPolicy {
  const manifest = parseManifest(env.PISA_CAPABILITIES ?? null);
  return {
    workdir: manifest?.workdir || env.PISA_WORKDIR || "",
    readDirs: manifest?.readDirs ?? [],
    writeDirs: manifest?.writeDirs ?? [],
    domains: manifest?.domains ?? [],
    gui: manifest?.gui ?? false,
    blockedCommands: manifest?.blockedCommands ?? [],
  };
}

const POLICY = policyFromEnv(process.env);

/** 文件工具的路径参数名，四者同等对待 */
const PATH_KEYS = ["path", "file_path", "filePath", "target"];

/** 会写文件的工具；其余按只读校验 */
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, ast_edit: true };

/** pi 扩展 API 的最小形状（上游没有发布类型） */
export interface WorkerEvent {
  toolName?: unknown;
  input?: Record<string, unknown>;
  sessionId?: unknown;
}

export interface WorkerContext {
  sessionManager?: { getSessionId?: () => unknown };
  cwd?: unknown;
}

export type Block = { block: true; reason: string };
export type Handler = (event: WorkerEvent, ctx: WorkerContext) => void | Block;

/** pi 只要求 on()，测试用同一个形状挂假 pi */
export interface Pi {
  on(name: string, handler: Handler): void;
}

function emit(obj: Record<string, unknown>): void {
  const file = process.env.PISA_PROGRESS_FILE;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
  } catch {
    // 进度上报失败不影响任务
  }
}

function bashDetail(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim().slice(0, 160);
}

function denied(tool: string, detail: string, reason: string): Block {
  emit({ type: "blocked", tool, detail: detail.slice(0, 200), reason });
  return { block: true, reason: `pisa guard：${reason}` };
}

export default async function (pi: Pi) {
  pi.on("session_start", (event, ctx) => {
    let sid = "";
    try {
      sid = String(ctx?.sessionManager?.getSessionId?.() ?? event?.sessionId ?? "");
    } catch {
      sid = "";
    }
    emit({ type: "session", sessionId: sid, cwd: ctx?.cwd ?? POLICY.workdir });
  });

  pi.on("tool_call", (event) => {
    const name = String(event?.toolName ?? "");
    const input = event?.input ?? {};

    if (name === "bash") {
      const cmd = String(input.command ?? "");
      const reason = blockBash(cmd, POLICY);
      if (reason) return denied(name, bashDetail(cmd), reason);
      emit({ type: "tool", tool: "bash", detail: bashDetail(cmd) });
      return;
    }

    const writable = WRITE_TOOLS[name] === true;
    for (const key of PATH_KEYS) {
      const value = input[key];
      if (typeof value !== "string") continue;
      const reason = writable ? outsideWritable(value, POLICY) : outsideReadable(value, POLICY);
      if (reason) return denied(name, value, reason);
    }

    const p = input.path ?? input.file_path ?? input.filePath ?? input.target;
    emit({ type: "tool", tool: name, detail: typeof p === "string" ? p.slice(0, 160) : "" });
  });

  pi.on("tool_result", (event) => {
    const name = String(event?.toolName ?? "");
    if (name === "bash") return; // bash 已在 tool_call 上报，避免重复
    emit({ type: "tool_done", tool: name });
  });

  pi.on("agent_end", () => emit({ type: "done" }));
}
