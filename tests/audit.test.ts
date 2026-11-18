import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, type AuditEntry } from "../src/audit";

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return { at: 1_700_000_000_000, actor: "u1", action: "dispatch", target: "t_1", ok: true, detail: "样本", ...over };
}

describe("审计日志", () => {
  let dir: string;
  let path: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeLog(): AuditLog {
    dir = mkdtempSync(join(tmpdir(), "pisa-audit-"));
    path = join(dir, "audit.log");
    return new AuditLog(path);
  }

  test("追加写入，读取最新在前并受 limit 限制", () => {
    const log = makeLog();
    log.record(entry({ at: 1, action: "dispatch" }));
    log.record(entry({ at: 2, action: "cancel" }));
    log.record(entry({ at: 3, action: "config.save", ok: false }));
    expect(log.tail().map((e) => e.action)).toEqual(["config.save", "cancel", "dispatch"]);
    expect(log.tail(2).map((e) => e.at)).toEqual([3, 2]);
  });

  test("敏感值脱敏，detail 截到 500 字", () => {
    const log = makeLog();
    log.record(entry({ detail: `token=super-secret ${"a".repeat(600)}` }));
    const [saved] = log.tail();
    expect(saved!.detail).toContain("token=<redacted>");
    expect(saved!.detail).toHaveLength(500);
  });

  test("坏行跳过，缺字段的记录丢弃", () => {
    const log = makeLog();
    log.record(entry({ at: 1 }));
    appendFileSync(path, "不是 JSON\n");
    appendFileSync(path, JSON.stringify({ actor: "u1" }) + "\n");
    log.record(entry({ at: 2 }));
    expect(log.tail().map((e) => e.at)).toEqual([2, 1]);
  });

  test("没有文件时返回空数组", () => {
    const log = makeLog();
    expect(log.tail()).toEqual([]);
  });
});
