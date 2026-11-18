import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { TaskLogger } from "../src/log";
import { dayKey, Retention, weekKey } from "../src/retention";
import { Store } from "../src/store";
import type { Task, TaskStatus } from "../src/types";

const DAY = 86_400_000;
/** 2026-11-18 星期三，ISO 第 47 周 */
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();

function setup(over: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pisa-retention-"));
  const store = new Store(":memory:");
  const cfg: Config = { ...DEFAULT_CONFIG, stateDir: dir, ...over };
  const retention = new Retention({ cfg, store, now: () => NOW });
  const done = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, retention, done };
}

function seed(store: Store, id: string, status: TaskStatus, endedAt: number | null): void {
  const task: Task = {
    id,
    source: `seed:${id}`,
    channel: "cli",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "保留测试",
    status,
    branch: null,
    prUrl: null,
    sessionId: null,
    baseRef: null,
    context: null,
    replyPr: null,
    replyIssue: null,
    replyRepo: null,
    mandate: null,
    policyVersion: null,
    summary: null,
    error: null,
    createdAt: endedAt ?? NOW - 100 * DAY,
    startedAt: null,
    endedAt,
    cancelRequested: false,
  };
  store.insertTask(task);
}

function writeProgress(dir: string, id: string): void {
  mkdirSync(join(dir, "progress"), { recursive: true });
  writeFileSync(join(dir, "progress", `${id}.jsonl`), '{"type":"tool"}\n');
}

const eventIds = (store: Store): string[] =>
  (store.db.query("SELECT event_id FROM events ORDER BY event_id").all() as Array<{ event_id: string }>).map(
    (r) => r.event_id,
  );

describe("保留键", () => {
  test("日期用本地时间，周用 ISO 周", () => {
    expect(dayKey(new Date(2026, 10, 18, 23, 59).getTime())).toBe("2026-11-18");
    expect(weekKey(new Date(2026, 10, 18).getTime())).toBe("2026-W47");
    expect(weekKey(new Date(2026, 10, 22).getTime())).toBe("2026-W47"); // 周日仍属同周
    expect(weekKey(new Date(2026, 10, 23).getTime())).toBe("2026-W48");
    expect(DEFAULT_CONFIG.retentionDays).toBe(30);
  });
});

describe("每日清理", () => {
  test("过期的终态任务清 events 与 progress，任务行保留；边界按结束时间严格小于", () => {
    const { dir, store, retention, done } = setup();
    seed(store, "t_expired", "succeeded", NOW - 31 * DAY);
    seed(store, "t_edge", "succeeded", NOW - 30 * DAY);
    seed(store, "t_fresh", "failed", NOW - 29 * DAY);
    for (const id of ["t_expired", "t_edge", "t_fresh"]) {
      store.claimEvent(`github:comment:1:${id}`, id, NOW - 31 * DAY);
      writeProgress(dir, id);
    }

    const r = retention.tick(new Date(NOW));

    expect(r.events).toBe(1);
    expect(r.progress).toBe(1);
    expect(store.get("t_expired")).not.toBeNull();
    expect(existsSync(join(dir, "progress", "t_expired.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "progress", "t_edge.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "progress", "t_fresh.jsonl"))).toBe(true);
    expect(eventIds(store)).not.toContain("github:comment:1:t_expired");
    // 结束时间在保留期内的事件即使 seen_at 很旧也不删：判据是任务结束时间
    expect(eventIds(store)).toContain("github:comment:1:t_edge");
    expect(eventIds(store)).toContain("github:comment:1:t_fresh");
    done();
  });

  test("未结束任务无论多老都不清理", () => {
    const { dir, store, retention, done } = setup();
    for (const [id, status] of [
      ["t_queued", "queued"],
      ["t_running", "running"],
      ["t_paused", "paused"],
    ] as const) {
      seed(store, id, status, null);
      store.claimEvent(`github:comment:1:${id}`, id, NOW - 90 * DAY);
      writeProgress(dir, id);
    }

    const r = retention.tick(new Date(NOW));

    expect(r.events).toBe(0);
    expect(r.progress).toBe(0);
    for (const id of ["t_queued", "t_running", "t_paused"]) {
      expect(store.get(id)?.status).toBe(id === "t_queued" ? "queued" : id === "t_running" ? "running" : "paused");
      expect(existsSync(join(dir, "progress", `${id}.jsonl`))).toBe(true);
    }
    expect(eventIds(store).filter((id) => id.startsWith("github:"))).toHaveLength(3);
    done();
  });

  test("同一本地日期只清理一次，次日再清", () => {
    const { dir, store, retention, done } = setup();
    seed(store, "t_a", "cancelled", NOW - 40 * DAY);
    writeProgress(dir, "t_a");
    expect(retention.tick(new Date(NOW)).progress).toBe(1);

    seed(store, "t_b", "rewound", NOW - 50 * DAY);
    store.claimEvent("github:comment:1:t_b", "t_b", NOW - 50 * DAY);
    writeProgress(dir, "t_b");
    const again = retention.tick(new Date(NOW));
    expect(again).toEqual({ events: 0, progress: 0, vacuumed: false });
    expect(store.get("t_b")).not.toBeNull();
    expect(existsSync(join(dir, "progress", "t_b.jsonl"))).toBe(true);

    const nextDay = retention.tick(new Date(NOW + DAY));
    expect(nextDay.events).toBe(1);
    expect(nextDay.progress).toBe(1);
    expect(existsSync(join(dir, "progress", "t_b.jsonl"))).toBe(false);
    done();
  });

  test("不属于任何任务的占位行按时间过期", () => {
    const { store, retention, done } = setup();
    store.claimEvent("cron-claim:job:old", "cron:job", NOW - 40 * DAY);
    store.claimEvent("cron-claim:job:new", "cron:job", NOW - DAY);

    const r = retention.tick(new Date(NOW));

    expect(r.events).toBe(1);
    expect(eventIds(store)).not.toContain("cron-claim:job:old");
    expect(eventIds(store)).toContain("cron-claim:job:new");
    done();
  });

  test("retentionDays 为 0 时关闭清理，VACUUM 照常", () => {
    const { dir, store, retention, done } = setup({ retentionDays: 0 });
    seed(store, "t_old", "succeeded", NOW - 400 * DAY);
    store.claimEvent("github:comment:1:t_old", "t_old", NOW - 400 * DAY);
    writeProgress(dir, "t_old");

    const r = retention.tick(new Date(NOW));

    expect(r.events).toBe(0);
    expect(r.progress).toBe(0);
    expect(r.vacuumed).toBe(true);
    expect(eventIds(store)).toContain("github:comment:1:t_old");
    expect(existsSync(join(dir, "progress", "t_old.jsonl"))).toBe(true);
    done();
  });

  test("自定义保留天数生效", () => {
    const { store, retention, done } = setup({ retentionDays: 7 });
    seed(store, "t_8d", "succeeded", NOW - 8 * DAY);
    seed(store, "t_6d", "succeeded", NOW - 6 * DAY);
    store.claimEvent("github:comment:1:t_8d", "t_8d", NOW - 8 * DAY);
    store.claimEvent("github:comment:1:t_6d", "t_6d", NOW - 6 * DAY);

    const r = retention.tick(new Date(NOW));

    expect(r.events).toBe(1);
    expect(eventIds(store)).not.toContain("github:comment:1:t_8d");
    expect(eventIds(store)).toContain("github:comment:1:t_6d");
    done();
  });
});

describe("每周 VACUUM", () => {
  test("同一 ISO 周只执行一次，跨周再执行", () => {
    const { retention, done } = setup();
    expect(retention.tick(new Date(2026, 10, 18)).vacuumed).toBe(true);
    expect(retention.tick(new Date(2026, 10, 22)).vacuumed).toBe(false); // 同周周日
    expect(retention.tick(new Date(2026, 10, 23)).vacuumed).toBe(true); // 下周一
    done();
  });
});

describe("日志轮转", () => {
  test("超过上限轮转为 .1，只保留一代", () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-log-"));
    const log = new TaskLogger(dir, "t1", 300);
    for (let i = 0; i < 12; i++) log.write("worker", `line-${i}-${"x".repeat(40)}`);

    expect(existsSync(`${log.path()}.1`)).toBe(true);
    expect(existsSync(`${log.path()}.2`)).toBe(false);
    expect(statSync(log.path()).size).toBeLessThanOrEqual(300);
    const lines = readFileSync(log.path(), "utf8").trim().split("\n");
    expect(lines.every((l) => JSON.parse(l).stage === "worker")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("未超过上限不轮转", () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-log-"));
    const log = new TaskLogger(dir, "t2", 10_000);
    for (let i = 0; i < 3; i++) log.write("worker", `line-${i}`);
    expect(existsSync(`${log.path()}.1`)).toBe(false);
    expect(readFileSync(log.path(), "utf8").trim().split("\n")).toHaveLength(3);
    rmSync(dir, { recursive: true, force: true });
  });
});
