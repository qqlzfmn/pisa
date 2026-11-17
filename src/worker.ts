import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { Config } from "./config";
import type { Task, WorkerResult } from "./types";
import { redact } from "./log";
import { getAdapter, type WorkerAdapter } from "./adapters";

/** 正在执行的 Worker 进程组（pgid = 子进程 pid）；关停时统一终止，避免留下孤儿继续改工作副本 */
const liveGroups = new Set<number>();

/** 终止所有在跑的 Worker 进程组；守护进程关停时调用，等价于前台 Ctrl-C 打到整个进程组 */
export function killRunningWorkers(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, signal);
    } catch {
      // 组已退出
    }
  }
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
      // 独立进程组：取消/超时要连子孙一起杀，否则子进程占着输出管道会让 run() 永远不返回
      detached: true,
    });
    liveGroups.add(proc.pid);

    // 杀掉整个进程组；组不存在时（子进程已退出）退回单个进程
    const killTree = (signal: "SIGTERM" | "SIGKILL") => {
      try {
        process.kill(-proc.pid, signal);
      } catch {
        try {
          proc.kill(signal);
        } catch {
          // 进程已退出
        }
      }
    };

    let timedOut = false;
    let cancelled = false;
    // 忽略 SIGTERM 的子孙会一直占着输出管道：兜底一次 SIGKILL，但句柄要能被清理
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      killTree("SIGTERM");
      if (hardKill) return;
      hardKill = setTimeout(() => {
        hardKill = undefined;
        killTree("SIGKILL");
      }, 5000);
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(1, this.cfg.timeoutSec) * 1000);

    const cancelPoll = setInterval(() => {
      if (isCancelled() && !cancelled) {
        cancelled = true;
        terminate();
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
    clearTimeout(hardKill);
    // 主动终止后补刀：忽略 SIGTERM 的子孙仍留在组里，组空时 kill 返回 ESRCH
    if (cancelled || timedOut) killTree("SIGKILL");
    liveGroups.delete(proc.pid);

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

/** 兼容旧名字 */
export const OmpWorker = Worker;
