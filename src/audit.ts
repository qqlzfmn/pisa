import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { readTail, redact, tailLines } from "./log";

const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

/** 控制台写操作的审计流水；JSONL 追加写，读尾部 */
export interface AuditEntry {
  at: number;
  actor: string;
  action: string;
  target: string;
  ok: boolean;
  detail: string;
}

export class AuditLog {
  constructor(private readonly path: string) {}

  record(entry: AuditEntry): void {
    const line = `${JSON.stringify({ ...entry, detail: redact(entry.detail).slice(0, 500) })}\n`;
    try {
      const size = existsSync(this.path) ? statSync(this.path).size : 0;
      if (size > 0 && size + Buffer.byteLength(line) > AUDIT_MAX_BYTES) renameSync(this.path, `${this.path}.1`);
      appendFileSync(this.path, line);
    } catch (err) {
      // 审计失败不阻塞业务，但要在进程日志里留下痕迹
      console.warn(`[pisa] 审计日志写入失败：${(err as Error).message}`);
    }
  }

  /** 最新在前；损坏行（例如轮转时写了半行）直接跳过 */
  tail(limit = 50): AuditEntry[] {
    if (!existsSync(this.path)) return [];
    const entries: AuditEntry[] = [];
    for (const line of tailLines(readTail(this.path), limit)) {
      try {
        const rec = JSON.parse(line) as Partial<AuditEntry>;
        if (typeof rec.at !== "number" || typeof rec.action !== "string") continue;
        entries.push({
          at: rec.at,
          actor: typeof rec.actor === "string" ? rec.actor : "",
          action: rec.action,
          target: typeof rec.target === "string" ? rec.target : "",
          ok: rec.ok === true,
          detail: typeof rec.detail === "string" ? rec.detail : "",
        });
      } catch {
        // 忽略坏行
      }
    }
    return entries.reverse();
  }
}
