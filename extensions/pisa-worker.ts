// pisa Worker 扩展：把 pi 生命周期事件写给 Router，并在 agent 内部执行策略。
// 判定逻辑在 guard.ts（纯函数、可单测），这里只做事件接线。
// 由 Router 通过 `omp -e extensions/pisa-worker.ts` 挂载。

import { appendFileSync, readFileSync } from "node:fs";
import { defaultRuntime, outsideRoots, type RuntimeCapabilities } from "../src/capabilities";
import { blockBash } from "./guard";

const FILE = process.env.PISA_PROGRESS_FILE;
const WORKDIR = process.env.PISA_WORKDIR ?? "";
const CAPABILITIES_FILE = process.env.PISA_CAPABILITIES_FILE;

/** 文件工具的路径参数名，四者同等对待 */
const PATH_KEYS = ["path", "file_path", "filePath", "target"];

/** 工具名命中这些词时按写工具处理，其余按读工具处理 */
const WRITE_TOOL = /write|edit|patch|create|delete|remove|move|rename|copy|mkdir|touch/i;

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

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : fallback;
}

/** 没有 manifest 时退回默认拒绝：只读写 workdir、不联网、不开 GUI */
function loadCapabilities(): RuntimeCapabilities {
  const fallback = defaultRuntime(WORKDIR);
  if (!CAPABILITIES_FILE) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(CAPABILITIES_FILE, "utf8")) as Record<string, unknown>;
    return {
      workdir: fallback.workdir,
      read: stringList(parsed.read, fallback.read),
      write: stringList(parsed.write, fallback.write),
      secrets: stringList(parsed.secrets, []),
      domains: stringList(parsed.domains, []),
      gui: parsed.gui === true,
      deny: stringList(parsed.deny, []),
      blocked: stringList(parsed.blocked, fallback.blocked),
    };
  } catch {
    return fallback;
  }
}

const CAPABILITIES = loadCapabilities();

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
  emit({ type: "blocked", tool, detail: detail.slice(0, 200), reason: reason.slice(0, 200) });
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
      const reason = blockBash(cmd, WORKDIR, CAPABILITIES);
      if (reason) return denied(name, bashDetail(cmd), reason);
      emit({ type: "tool", tool: "bash", detail: bashDetail(cmd) });
      return;
    }

    const roots = WRITE_TOOL.test(name) ? CAPABILITIES.write : CAPABILITIES.read;
    for (const key of PATH_KEYS) {
      const value = input[key];
      if (typeof value !== "string") continue;
      const reason = outsideRoots(value, roots, CAPABILITIES.workdir);
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
