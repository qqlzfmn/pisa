import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { Config } from "./config";
import type { Task, WorkerResult } from "./types";
import { redact } from "./log";
import { clip } from "./text";
import { getAdapter, type WorkerAdapter } from "./adapters";

export interface WorkerRunner {
  run(
    task: Task,
    workdir: string,
    onLog: (line: string) => void,
    isCancelled: () => boolean,
    /** 恢复中断任务：接着原会话执行 */
    resume?: boolean,
  ): Promise<WorkerResult>;
}

export class Worker implements WorkerRunner {
  private adapter: WorkerAdapter;

  constructor(
    private cfg: Config["worker"],
    private stateDir = ".pisa",
  ) {
    this.adapter = getAdapter(cfg.adapter ?? "omp");
  }

  async run(
    task: Task,
    workdir: string,
    onLog: (line: string) => void,
    isCancelled: () => boolean,
    resume = false,
  ): Promise<WorkerResult> {
    const extensionPath = join(import.meta.dir, "..", "extensions", "pisa-worker.ts");
    const progressDir = resolve(this.stateDir, "progress");
    mkdirSync(progressDir, { recursive: true });

    const input = {
      task,
      workdir,
      extensionPath,
      progressFile: join(progressDir, `${task.id}.jsonl`),
      cfg: this.cfg,
      resume,
      resumeSessionId: resume ? task.sessionId : null,
    };
    const proc = Bun.spawn(this.adapter.buildArgs(input), {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...this.adapter.buildEnv(input) },
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

    let lastText = "";
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
          if (!line.trim()) continue;
          if (kind === "err") {
            const clean = line.trim();
            rawTail.push(clean);
            onLog(`[stderr] ${clean}`);
            continue;
          }
          const parsed = this.adapter.parseLine(line);
          if (parsed.text && parsed.text !== lastText) lastText = parsed.text;
          if (parsed.raw) rawTail.push(parsed.raw);
          onLog(line.slice(0, 2000));
        }
      }
      if (buf.trim()) rawTail.push(buf.trim());
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

    // 摘要就是 Worker 的最后一条消息：提示词要求它把结论写在最后一条，
    // 下游（下一轮上下文、评审、回帖）直接拿摘要当结论读，拼进过程闲聊会把结论挤出首行。
    const summary = clip(redact((lastText || rawTail.slice(-40).join("\n")).trim()), 4000);
    if (exitCode !== 0) {
      const err = rawTail.slice(-20).join("\n") || `Worker 退出码 ${exitCode}`;
      return { ok: false, summary, error: redact(err).slice(0, 2000), exitCode };
    }
    return { ok: true, summary: summary || "（Worker 未返回文字摘要）", exitCode };
  }
}

/** 兼容旧名字 */
export const OmpWorker = Worker;
