import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(bot\d+:[A-Za-z0-9_-]{20,})/g, "bot<redacted>"],
  [/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1<redacted>"],
  [/(gh[pousr]_[A-Za-z0-9]{20,})/g, "<redacted>"],
  [/(sk-[A-Za-z0-9]{16,})/g, "<redacted>"],
];

export function redact(line: string): string {
  let out = line;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

export class TaskLogger {
  private file: string;
  constructor(stateDir: string, taskId: string) {
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
    appendFileSync(this.file, line + "\n");
  }

  path(): string {
    return this.file;
  }
}

export function ensureDir(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
}

export interface LogLine {
  ts: string;
  stage: string;
  msg: string;
}

/** 日志尾部读取上限：轮询不随日志增长变慢 */
const TAIL_BYTES = 128 * 1024;
const TAIL_LINES = 200;

/** 读任务日志最新若干行，按 TaskLogger 的 JSON 行解析；解析失败保留原文 */
export function readLogTail(stateDir: string, taskId: string, limit = TAIL_LINES): LogLine[] {
  const file = join(stateDir, "logs", `${taskId}.log`);
  let raw: string;
  try {
    const fd = openSync(file, "r");
    try {
      const { size } = fstatSync(fd);
      const length = Math.min(size, TAIL_BYTES);
      const start = size - length;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, start);
      raw = buf.toString("utf8");
      // 起点落在行中间时丢掉第一段残行
      if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }

  return raw
    .split("\n")
    .filter((line) => line.trim())
    .slice(-limit)
    .map((line) => {
      try {
        const o = JSON.parse(line) as { ts?: string; stage?: string; msg?: string };
        return { ts: String(o.ts ?? ""), stage: String(o.stage ?? ""), msg: String(o.msg ?? "") };
      } catch {
        return { ts: "", stage: "raw", msg: line };
      }
    });
}
