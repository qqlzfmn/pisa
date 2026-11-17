import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLogTail } from "../src/log";

const TAIL_BYTES = 128 * 1024;

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pisa-log-"));
  mkdirSync(join(stateDir, "logs"), { recursive: true });
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function writeLog(raw: string): void {
  writeFileSync(join(stateDir, "logs", "t_main.log"), raw);
}

test("小文件整段返回", () => {
  writeLog(
    [
      JSON.stringify({ ts: "1", stage: "a", msg: "一" }),
      JSON.stringify({ ts: "2", stage: "b", msg: "二" }),
    ].join("\n") + "\n",
  );
  expect(readLogTail(stateDir, "t_main").map((l) => l.stage)).toEqual(["a", "b"]);
});

test("起点正好落在行首时不丢完整行", () => {
  const a = JSON.stringify({ ts: "1", stage: "a", msg: "一" });
  const b = JSON.stringify({ ts: "2", stage: "b", msg: "二" });
  // 前缀恰好 TAIL_BYTES 字节并以换行结尾：读取窗口的起点就是 a 的开头
  writeLog("x".repeat(TAIL_BYTES - 1) + "\n" + a + "\n" + b + "\n");
  expect(readLogTail(stateDir, "t_main").map((l) => l.stage)).toEqual(["a", "b"]);
});

test("超过窗口且没有换行时返回空，不吐半截残片", () => {
  writeLog("x".repeat(TAIL_BYTES + 10));
  expect(readLogTail(stateDir, "t_main")).toEqual([]);
});
