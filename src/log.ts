import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(bot\d+:[A-Za-z0-9_-]{20,})/g, "bot<redacted>"],
  [/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1<redacted>"],
  [/(gh[pousr]_[A-Za-z0-9]{20,})/g, "<redacted>"],
  [/(sk-[A-Za-z0-9]{16,})/g, "<redacted>"],
];

/** 单个任务日志的上限：超过即轮转出一代 .1 备份，单行超限则截断 */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;

const TRUNCATED = "…[truncated]";

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
    const line = this.format(stage, message);
    // 超限先轮转：改名覆盖上一代 .1，只保留一代，主文件继续写
    const size = existsSync(this.file) ? statSync(this.file).size : 0;
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
      renameSync(this.file, `${this.file}.1`);
    }
    appendFileSync(this.file, line);
  }

  /**
   * 序列化一行；超过上限时按字符边界截断 message 并加标记。
   * JSON 转义会放大字节数，所以二分出能放下的最长前缀，保证落盘行不超过上限。
   */
  private format(stage: string, message: string): string {
    const ts = new Date().toISOString();
    const msg = redact(message);
    const render = (m: string): string => JSON.stringify({ ts, stage, msg: m }) + "\n";
    if (Buffer.byteLength(render(msg)) <= this.maxBytes) return render(msg);

    let lo = 0;
    let hi = msg.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(render(msg.slice(0, mid) + TRUNCATED)) <= this.maxBytes) lo = mid;
      else hi = mid - 1;
    }
    return render(msg.slice(0, lo) + TRUNCATED);
  }

  path(): string {
    return this.file;
  }
}

export function ensureDir(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
}
