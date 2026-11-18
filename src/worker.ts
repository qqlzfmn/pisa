import { join, resolve } from "node:path";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { DEFAULT_ENV_ALLOW, type Config } from "./config";
import type { Task, WorkerResult } from "./types";
import { redact, TaskLogger } from "./log";
import { getAdapter, type WorkerAdapter } from "./adapters";
import {
  buildManifest,
  capabilityEnv,
  DENY_ALL,
  envAllowWithSecrets,
  type Capabilities,
} from "./capabilities";

/**
 * 按白名单从源环境里挑变量：只复制允许且实际存在的键，缺省键不生成空值。
 * 纯函数，Worker.run 与启动日志共用同一判断。
 */
export function workerEnv(
  allow: readonly string[],
  src: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allow) {
    const value = src[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface WorkerRunner {
  run(
    task: Task,
    workdir: string,
    onLog: (line: string) => void,
    isCancelled: () => boolean,
    /** 恢复中断任务：接着原会话执行 */
    resume?: boolean,
    /** 解析后的能力清单；缺省全拒 */
    capabilities?: Capabilities,
  ): Promise<WorkerResult>;
}

/** 从进度文件汇总被 guard 拒绝的操作，供任务日志审计 */
export function blockedEvents(file: string): string[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { type?: string; tool?: string; detail?: string; reason?: string };
      if (e.type !== "blocked") continue;
      const at = [e.tool, e.detail].filter(Boolean).join(" · ");
      out.push(e.reason ? `${at}：${e.reason}` : at || "（未说明）");
    } catch {
      /* 半行或非 JSON 忽略 */
    }
  }
  return out;
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
    capabilities: Capabilities = DENY_ALL,
  ): Promise<WorkerResult> {
    const extensionPath = join(import.meta.dir, "..", "extensions", "pisa-worker.ts");
    const progressDir = resolve(this.stateDir, "progress");
    mkdirSync(progressDir, { recursive: true });

    // 能力清单先落盘再启动：任务记录能回答「这次被授予了什么」
    const manifest = buildManifest({
      taskId: task.id,
      profile: task.capability ?? null,
      workdir,
      capabilities,
    });
    const capsDir = resolve(this.stateDir, "capabilities");
    mkdirSync(capsDir, { recursive: true });
    const manifestPath = join(capsDir, `${task.id}.json`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    new TaskLogger(this.stateDir, task.id).write(
      "capability",
      `能力清单 · 档位 ${manifest.profile ?? "仓库基线"} · 密钥 ${manifest.secrets.join(",") || "无"} · 域名 ${
        manifest.domains.join(",") || "无"
      } · GUI ${manifest.gui ? "开启" : "关闭"} · 清单 ${manifestPath}`,
    );

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
      // 只继承白名单 + 本任务声明的密钥变量；适配器与能力注入的 PISA_* 始终放行
      env: {
        ...workerEnv(
          envAllowWithSecrets(this.cfg.envAllow ?? DEFAULT_ENV_ALLOW, capabilities.secrets),
          process.env,
        ),
        ...this.adapter.buildEnv(input),
        ...capabilityEnv(manifest),
      },
    });

    let timedOut = false;
    let idleTimedOut = false;
    let cancelled = false;
    let lastActivity = Date.now();
    const idleMs = Math.max(60, this.cfg.idleTimeoutSec ?? 900) * 1000;
    const killTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 10_000);
    }, Math.max(1, this.cfg.timeoutSec) * 1000);

    // 卡死检测：进度文件与输出都长时间没变化就杀掉，避免任务永久 running
    const idleTimer = setInterval(() => {
      try {
        const m = statSync(input.progressFile).mtimeMs;
        if (m > lastActivity) lastActivity = m;
      } catch {
        /* 进度文件还没生成 */
      }
      if (Date.now() - lastActivity > idleMs) {
        idleTimedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 10_000);
        clearInterval(idleTimer);
      }
    }, 30_000);

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
          lastActivity = Date.now();
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
    clearInterval(idleTimer);
    clearInterval(cancelPoll);

    const blocked = blockedEvents(input.progressFile);
    const audit = blocked.length ? { blocked } : {};

    if (cancelled) return { ok: false, summary: "", error: "任务已取消", exitCode, ...audit };
    if (idleTimedOut) {
      return { ok: false, summary: "", error: `卡死：超过 ${Math.round(idleMs / 1000)} 秒没有任何输出或进度`, exitCode, ...audit };
    }
    if (timedOut) return { ok: false, summary: "", error: `执行超时（${this.cfg.timeoutSec}s）`, exitCode, ...audit };

    const summary = redact((texts.join("\n\n") || rawTail.slice(-40).join("\n")).trim()).slice(0, 4000);
    if (exitCode !== 0) {
      const err = rawTail.slice(-20).join("\n") || `Worker 退出码 ${exitCode}`;
      return { ok: false, summary, error: redact(err).slice(0, 2000), exitCode, ...audit };
    }
    return { ok: true, summary: summary || "（Worker 未返回文字摘要）", exitCode, ...audit };
  }
}

/** 兼容旧名字 */
export const OmpWorker = Worker;
