import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { Config } from "./config";
import type { Task, WorkerResult } from "./types";
import { redact } from "./log";
import { getAdapter, type WorkerAdapter } from "./adapters";

/** 评审首行契约，见 `reviewPrompt` 与 `REVIEW_CONSTRAINTS` */
const REVIEW_VERDICT = /^结论[*_]*[：:][*_]*\s*(?:可以合并|有阻塞问题|需要讨论)/;

/**
 * 评审结论：提示词要求最后一条助手消息的第一行写 `结论：…`，但模型有时在结论后面
 * 再补一句收尾，位置不可靠，所以从最后一条消息往前找首行符合契约的那条。首行的
 * Markdown 装饰（`**`、`##`、`>`、`- `）不算内容。
 */
function reviewConclusion(texts: string[]): string | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const lines = texts[i]!.split("\n").map((line) => line.replace(/^[\s*_#>`-]+/, ""));
    if (REVIEW_VERDICT.test(lines.find((line) => line.trim()) ?? "")) return texts[i]!;
  }
  return null;
}

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
          if (!line.trim()) continue;
          if (kind === "err") {
            const clean = line.trim();
            rawTail.push(clean);
            onLog(`[stderr] ${clean}`);
            continue;
          }
          const parsed = this.adapter.parseLine(line);
          if (parsed.text && texts[texts.length - 1] !== parsed.text) texts.push(parsed.text);
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

    // 评审回帖的正文是结论，工作任务的摘要仍是全部助手消息拼接
    const narrative = task.mode === "review" ? (texts[texts.length - 1] ?? "") : texts.join("\n\n");
    const summary = redact((narrative || rawTail.slice(-40).join("\n")).trim()).slice(0, 4000);
    if (exitCode !== 0) {
      const err = rawTail.slice(-20).join("\n") || `Worker 退出码 ${exitCode}`;
      return { ok: false, summary, error: redact(err).slice(0, 2000), exitCode };
    }
    if (task.mode === "review") {
      const conclusion = reviewConclusion(texts);
      if (!conclusion) {
        const said = summary.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 80) ?? "（没有助手消息）";
        return {
          ok: false,
          summary,
          error: redact(
            `评审没有产出结论：助手消息首行不是「结论：可以合并 / 有阻塞问题 / 需要讨论」，没有可回帖的内容（首行：${said}）`,
          ),
          exitCode,
        };
      }
      return { ok: true, summary: redact(conclusion.trim()).slice(0, 4000), exitCode };
    }
    return { ok: true, summary: summary || "（Worker 未返回文字摘要）", exitCode };
  }
}

/** 兼容旧名字 */
export const OmpWorker = Worker;
