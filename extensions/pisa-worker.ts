// pisa Worker 扩展：把 pi 生命周期事件写给 Router，并在 agent 内部执行策略。
// 判定逻辑在 guard.ts（纯函数、可单测），这里只做事件接线。
// 由 Router 通过 `omp -e extensions/pisa-worker.ts` 挂载。

import { appendFileSync } from "node:fs";
import {
  blockBash,
  isGuiTool,
  isWriteTool,
  outsideAllowed,
  parseCapabilities,
  type GuardCapabilities,
} from "./guard";

const FILE = process.env.PISA_PROGRESS_FILE;
const WORKDIR = process.env.PISA_WORKDIR ?? "";

/** 清单缺失或损坏时按默认拒绝：无读目录、无写目录、无域名、无 GUI */
const DEFAULT_CAPS: GuardCapabilities = { read: [], write: [], domains: [], gui: false, blocked: [] };
const CAPS = parseCapabilities(process.env.PISA_CAPABILITIES) ?? DEFAULT_CAPS;

/** 文件工具的路径参数名，四者同等对待 */
const PATH_KEYS = ["path", "file_path", "filePath", "target"];

/** pi 扩展 API 的最小形状（上游没有发布类型） */
interface WorkerEvent {
  toolName?: unknown;
  input?: Record<string, unknown>;
  sessionId?: unknown;
}

interface WorkerContext {
  sessionManager?: { getSessionId?: () => unknown };
  cwd?: unknown;
}

type Block = { block: true; reason: string };
type Handler = (event: WorkerEvent, ctx: WorkerContext) => void | Block;

interface Pi {
  on(name: string, handler: Handler): void;
}

function emit(obj: Record<string, unknown>): void {
  if (!FILE) return;
  try {
    appendFileSync(FILE, JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
  } catch {
    // 进度上报失败不影响任务
  }
}

function bashDetail(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim().slice(0, 160);
}

function denied(tool: string, detail: string, reason: string): Block {
  emit({ type: "blocked", tool, detail: detail.slice(0, 200), reason: reason.slice(0, 300) });
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
    emit({ type: "session", sessionId: sid, cwd: ctx?.cwd ?? WORKDIR });
  });

  pi.on("tool_call", (event) => {
    const name = String(event?.toolName ?? "");
    const input = event?.input ?? {};

    if (name === "bash") {
      const cmd = String(input.command ?? "");
      const reason = blockBash(cmd, WORKDIR, CAPS);
      if (reason) return denied(name, bashDetail(cmd), reason);
      emit({ type: "tool", tool: "bash", detail: bashDetail(cmd) });
      return;
    }

    const paths = PATH_KEYS.map((k) => input[k]).filter((v): v is string => typeof v === "string");
    const detail = (paths[0] ?? "").slice(0, 160);

    if (isGuiTool(name) && !CAPS.gui) return denied(name, detail, "未开启 GUI 能力");

    const roots = isWriteTool(name) ? CAPS.write : CAPS.read;
    for (const value of paths) {
      const reason = outsideAllowed(value, WORKDIR, roots);
      if (reason) return denied(name, value, reason);
    }

    emit({ type: "tool", tool: name, detail });
  });

  pi.on("tool_result", (event) => {
    const name = String(event?.toolName ?? "");
    if (name === "bash") return; // bash 已在 tool_call 上报，避免重复
    emit({ type: "tool_done", tool: name });
  });

  pi.on("agent_end", () => emit({ type: "done" }));
}
