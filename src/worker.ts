import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { Config } from "./config";
import type { Task, WorkerResult } from "./types";
import { redact } from "./log";

export interface WorkerRunner {
  run(task: Task, workdir: string, onLog: (line: string) => void, isCancelled: () => boolean): Promise<WorkerResult>;
}

export function buildPrompt(task: Task): string {
  return [
    `你是 pisa 的 Worker，任务号 ${task.id}。`,
    ``,
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
    .map((c) => (typeof c === "string" ? c : typeof (c as { text?: string }).text === "string" ? (c as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export class OmpWorker implements WorkerRunner {
  constructor(
    private cfg: Config["worker"],
    private stateDir = ".pisa",
  ) {}

  async run(
    task: Task,
    workdir: string,
    onLog: (line: string) => void,
    isCancelled: () => boolean,
  ): Promise<WorkerResult> {
    const extensionPath = join(import.meta.dir, "..", "extensions", "pisa-worker.ts");
    const progressDir = resolve(this.stateDir, "progress");
    mkdirSync(progressDir, { recursive: true });
    const args = [
      this.cfg.command,
      ...this.cfg.extraArgs,
      "-e",
      extensionPath,
      ...(task.resumeSessionId ? ["-r", task.resumeSessionId] : []),
      "--mode=json",
      "-p",
      buildPrompt(task),
      "--cwd",
      workdir,
    ];

    const proc = Bun.spawn(args, {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PISA_WORKDIR: workdir,
        PISA_PROGRESS_FILE: join(progressDir, `${task.id}.jsonl`),
      },
    });

    let timedOut = false;
    let cancelled = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 10_000);
    }, Math.max(1, this.cfg.timeoutSec) * 1000);

    const cancelPoll = setInterval(() => {
      if (isCancelled() && !cancelled) {
        cancelled = true;
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5_000);
      }
    }, 2000);

    const texts: string[] = [];
    const rawTail: string[] = [];

    const pump = async (stream: ReadableStream<Uint8Array>, kind: "out" | "err") => {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const clean = line.replace(ANSI, "").trim();
          if (!clean) continue;
          if (kind === "err") {
            rawTail.push(clean);
            onLog(`[stderr] ${clean}`);
            continue;
          }
          try {
            const obj = JSON.parse(clean) as JsonEvent;
            const t = assistantText(obj);
            if (t && texts[texts.length - 1] !== t) texts.push(t);
            onLog(clean.slice(0, 2000));
          } catch {
            rawTail.push(clean);
            onLog(clean.slice(0, 2000));
          }
        }
      }
      if (buf.trim()) rawTail.push(buf.replace(ANSI, "").trim());
    };

    const [exitCode] = await Promise.all([
      proc.exited,
      pump(proc.stdout as ReadableStream<Uint8Array>, "out"),
      pump(proc.stderr as ReadableStream<Uint8Array>, "err"),
    ]);

    clearTimeout(killTimer);
    clearInterval(cancelPoll);

    if (cancelled) return { ok: false, summary: "", error: "任务已取消", exitCode };
    if (timedOut) return { ok: false, summary: "", error: `执行超时（${this.cfg.timeoutSec}s）`, exitCode };

    const summary = redact((texts.join("\n\n") || rawTail.slice(-40).join("\n")).trim()).slice(0, 4000);
    if (exitCode !== 0) {
      const err = rawTail.slice(-20).join("\n") || `Worker 退出码 ${exitCode}`;
      return { ok: false, summary, error: redact(err).slice(0, 2000), exitCode };
    }
    return { ok: true, summary: summary || "（Worker 未返回文字摘要）", exitCode };
  }
}
