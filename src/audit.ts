import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTail, redact, tailLines } from "./log";

/**
 * Web 写操作的审计记录：一行一个 JSON，落在 `<stateDir>/audit.log`。
 * 记录只描述「谁在什么时候动了什么、成没成功」，正文经 redact 去掉凭据。
 */
export interface AuditEntry {
  at: number;
  actor: string;
  /** 动作标识：task.dispatch / task.cancel / task.merge / task.rewind / config.save */
  action: string;
  /** 作用对象：任务号或配置文件 */
  target: string;
  ok: boolean;
  /** 结果摘要；失败为错误原文 */
  detail: string;
}

export interface AuditInput {
  actor: string;
  action: string;
  target: string;
  ok: boolean;
  detail?: string;
}

/** 单行上限：审计要能读，不保存整份 prompt */
const DETAIL_MAX = 1000;
/** 文件超过该大小先裁到最近 KEEP_LINES 行，常驻进程不会把审计写爆 */
const AUDIT_MAX_BYTES = 512 * 1024;
const KEEP_LINES = 500;

export function auditPath(stateDir: string): string {
  return join(stateDir, "audit.log");
}

function trim(file: string): void {
  if (statSync(file).size <= AUDIT_MAX_BYTES) return;
  writeFileSync(file, tailLines(readTail(file, AUDIT_MAX_BYTES), KEEP_LINES).join("\n") + "\n");
}

export function appendAudit(stateDir: string, input: AuditInput, at = Date.now()): AuditEntry {
  const entry: AuditEntry = {
    at,
    actor: input.actor,
    action: input.action,
    target: input.target.slice(0, 200),
    ok: input.ok,
    detail: redact(input.detail ?? "").slice(0, DETAIL_MAX),
  };
  mkdirSync(stateDir, { recursive: true });
  const file = auditPath(stateDir);
  if (existsSync(file)) trim(file);
  appendFileSync(file, JSON.stringify(entry) + "\n");
  return entry;
}

/** 最近的审计记录，新 → 旧；损坏或被手改的行跳过 */
export function readAudit(stateDir: string, limit = 50): AuditEntry[] {
  const file = auditPath(stateDir);
  if (!existsSync(file)) return [];
  const entries: AuditEntry[] = [];
  for (const line of tailLines(readTail(file, AUDIT_MAX_BYTES), Math.max(1, limit))) {
    try {
      const raw = JSON.parse(line) as Partial<AuditEntry>;
      if (typeof raw.action !== "string" || typeof raw.target !== "string") continue;
      entries.push({
        at: typeof raw.at === "number" ? raw.at : 0,
        actor: typeof raw.actor === "string" ? raw.actor : "",
        action: raw.action,
        target: raw.target,
        ok: raw.ok === true,
        detail: typeof raw.detail === "string" ? raw.detail : "",
      });
    } catch {
      // 部分行被裁掉或人工编辑：忽略
    }
  }
  return entries.reverse();
}
