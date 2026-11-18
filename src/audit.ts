import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { readTail, tailLines } from "./log";

/** Web 与 IM 的写操作都记这里，出问题能追到谁在什么时候做了什么 */
export type AuditAction =
  | "dispatch"
  | "cancel"
  | "merge"
  | "rewind"
  | "retry"
  | "executor.pause"
  | "executor.resume"
  | "config.save";

export interface AuditEntry {
  ts: number;
  /** 操作者：Web 用户 id 或 IM 发送者 */
  actor: string;
  action: AuditAction;
  /** 任务 id 或配置文件路径 */
  target: string;
  ok: boolean;
  detail: string | null;
}

export const AUDIT_MAX_BYTES = 1024 * 1024;

/** 审计日志：`<stateDir>/audit.log`，每行一条 JSON，超限轮转一代 */
export class AuditLog {
  readonly file: string;

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "audit.log");
  }

  append(entry: Omit<AuditEntry, "ts"> & { ts?: number }): AuditEntry {
    const full: AuditEntry = {
      ts: entry.ts ?? this.now(),
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      ok: entry.ok,
      detail: entry.detail ?? null,
    };
    this.rotate();
    appendFileSync(this.file, JSON.stringify(full) + "\n");
    return full;
  }

  /** 最近 limit 条，按时间正序；损坏的行跳过 */
  recent(limit = 50): AuditEntry[] {
    if (!existsSync(this.file) || limit <= 0) return [];
    const out: AuditEntry[] = [];
    for (const line of tailLines(readTail(this.file), limit)) {
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        continue;
      }
    }
    return out;
  }

  private rotate(): void {
    if (!existsSync(this.file)) return;
    if (statSync(this.file).size < AUDIT_MAX_BYTES) return;
    renameSync(this.file, `${this.file}.1`);
  }
}
