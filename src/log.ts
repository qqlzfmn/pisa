import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(bot\d+:[A-Za-z0-9_-]{20,})/g, "bot<redacted>"],
  [/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1<redacted>"],
  [/(gh[pousr]_[A-Za-z0-9]{20,})/g, "<redacted>"],
  [/(sk-[A-Za-z0-9]{16,})/g, "<redacted>"],
];

/** 单个任务日志的上限：超过即轮转出一代 .1 备份 */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

export function redact(line: string): string {
  let out = line;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

export class TaskLogger {
  private file: string;

  constructor(stateDir: string, taskId: string, private maxBytes = LOG_MAX_BYTES) {
    const dir = join(stateDir, "logs");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${taskId}.log`);
  }

  write(stage: string, message: string): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      stage,
      msg: redact(message),
    });
    // 超限先轮转：改名覆盖上一代 .1，只保留一代，主文件继续写
    const size = existsSync(this.file) ? statSync(this.file).size : 0;
    if (size > 0 && size + Buffer.byteLength(line) + 1 > this.maxBytes) {
      renameSync(this.file, `${this.file}.1`);
    }
    appendFileSync(this.file, line + "\n");
  }

  path(): string {
    return this.file;
  }
}

export function ensureDir(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
}

/** 读文件尾部；日志可能很大，只取最后 maxBytes */
export function readTail(path: string, maxBytes = 64 * 1024): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf8");
}

/** 非空行里的最后 count 行；尾部可能从半行开始，调用方按解析失败原样处理 */
export function tailLines(text: string, count: number): string[] {
  return text.split("\n").filter((line) => line.length > 0).slice(-count);
}

/** 任务日志的文本尾部：JSONL 转 `HH:MM:SS stage msg`，坏行原样保留 */
export function taskLogTail(stateDir: string, taskId: string, count: number): string[] {
  const path = join(stateDir, "logs", `${taskId}.log`);
  if (!existsSync(path)) return [];
  return tailLines(readTail(path), count).map((line) => {
    try {
      const rec = JSON.parse(line) as { ts?: number; stage?: string; msg?: string };
      const time = typeof rec.ts === "number" ? new Date(rec.ts).toTimeString().slice(0, 8) : "-";
      return `${time} ${rec.stage ?? "-"} ${rec.msg ?? ""}`.trimEnd();
    } catch {
      return line;
    }
  });
}
