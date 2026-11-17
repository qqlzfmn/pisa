import { appendFileSync, mkdirSync } from "node:fs";
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
