import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { evaluateOpsStatus, formatOpsIssues, OPS_EXIT, type OpsStatus } from "../src/ops-status";
import { StatusPatrol, PATROL_META_KEY, patrolSignature } from "../src/patrol";
import { Store } from "../src/store";
import type { IncomingMessage } from "../src/types";

function cfg(over: Partial<Config> = {}): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: "/tmp/demo", baseBranch: "main" }],
    worker: { adapter: "omp", command: "omp", timeoutSec: 60, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir: ".pisa-test",
    ...over,
  };
}

const NOW = 1_000_000;

function memStore(): { meta: Map<string, string>; store: { getMeta: (k: string) => string | null; setMeta: (k: string, v: string) => void } } {
  const meta = new Map<string, string>();
  return { meta, store: { getMeta: (k) => meta.get(k) ?? null, setMeta: (k, v) => void meta.set(k, v) } };
}

describe("状态判定", () => {
  test("心跳新鲜、无失败动作时正常", () => {
    const store = new Store(":memory:");
    store.beat(NOW);
    const ops = evaluateOpsStatus(cfg(), store, NOW + 1_000);
    expect(ops.exitCode).toBe(OPS_EXIT.ok);
    expect(ops.label).toBe("正常");
    expect(ops.issues).toEqual([]);
    store.close();
  });

  test("心跳失效需要重启", () => {
    const store = new Store(":memory:");
    const ops = evaluateOpsStatus(cfg(), store, NOW);
    expect(ops.exitCode).toBe(OPS_EXIT.restart);
    expect(ops.label).toBe("需重启");
    expect(ops.issues.map((i) => i.key)).toEqual(["daemon:heartbeat"]);
    expect(ops.issues[0]!.detail).toContain("没有心跳记录");

    store.beat(NOW - 60_000);
    expect(evaluateOpsStatus(cfg(), store, NOW).issues[0]!.detail).toContain("1m0s 前");
    store.close();
  });

  test("仓库为空待配置，且优先于重启", () => {
    const store = new Store(":memory:");
    const ops = evaluateOpsStatus(cfg({ repos: [] }), store, NOW);
    expect(ops.exitCode).toBe(OPS_EXIT.setup);
    expect(ops.label).toBe("待配置");
    expect(ops.issues.map((i) => i.key)).toContain("config:repos");
    store.close();
  });

  test("重试用尽的外部动作是部件错误，优先于重启", () => {
    const store = new Store(":memory:");
    store.enqueueEffect({ kind: "push", key: "k1", taskId: null, payload: "{}", at: NOW });
    store.failEffect("push", "k1", "origin rejected", { nextAt: NOW, terminal: true }, NOW);
    store.enqueueEffect({ kind: "push", key: "k2", taskId: null, payload: "{}", at: NOW });
    store.failEffect("push", "k2", "timeout", { nextAt: NOW + 1_000, terminal: false }, NOW);

    const ops = evaluateOpsStatus(cfg(), store, NOW);
    expect(ops.exitCode).toBe(OPS_EXIT.component);
    expect(ops.label).toBe("部件错误");
    expect(ops.issues.map((i) => i.key)).toEqual(["effect:push:k1", "daemon:heartbeat"]);
    expect(ops.issues[0]!.detail).toContain("重试 1 次后失败：origin rejected");
    store.close();
  });

  test("明细超过上限时说明还有多少条", () => {
    const issues = Array.from({ length: 8 }, (_, i) => ({ code: 1 as const, key: `k${i}`, detail: `问题 ${i}` }));
    expect(formatOpsIssues(issues, 5)).toHaveLength(6);
    expect(formatOpsIssues(issues, 5).at(-1)).toBe("- 另有 3 项未展开");
  });
});

describe("状态巡检", () => {
  test("正常静默，恢复后清空去重键", () => {
    const { meta, store } = memStore();
    const got: IncomingMessage[] = [];
    let ops: OpsStatus = { exitCode: 0, label: "正常", issues: [] };
    const patrol = new StatusPatrol({
      cfg: cfg({ proactive: { patrol: { chatId: "c1", userId: "u1" } } }),
      store,
      enqueue: (m) => void got.push(m),
      evaluate: () => ops,
      now: () => NOW,
    });
    patrol.tick();
    expect(got).toHaveLength(0);
    expect(meta.get(PATROL_META_KEY)).toBeUndefined();

    ops = { exitCode: 1, label: "需重启", issues: [{ code: 1, key: "daemon:heartbeat", detail: "守护进程没有心跳记录" }] };
    patrol.tick();
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toContain("pisa 状态异常（1 需重启）");
    expect(got[0]!.chatId).toBe("c1");
    expect(meta.get(PATROL_META_KEY)).toBe("daemon:heartbeat");

    ops = { exitCode: 0, label: "正常", issues: [] };
    patrol.tick();
    expect(meta.get(PATROL_META_KEY)).toBe("");
    expect(got).toHaveLength(1);
  });

  test("同一问题去重，问题变化后再提醒", () => {
    const { store } = memStore();
    const got: IncomingMessage[] = [];
    let ops: OpsStatus = { exitCode: 3, label: "待配置", issues: [{ code: 3, key: "config:repos", detail: "配置里没有仓库" }] };
    const patrol = new StatusPatrol({
      cfg: cfg({ proactive: { patrol: { chatId: "c1", userId: "u1" } } }),
      store,
      enqueue: (m) => void got.push(m),
      evaluate: () => ops,
      now: () => NOW,
    });

    patrol.tick();
    patrol.tick();
    expect(got).toHaveLength(1);

    ops = {
      exitCode: 3,
      label: "待配置",
      issues: [
        { code: 3, key: "config:repos", detail: "配置里没有仓库" },
        { code: 1, key: "daemon:heartbeat", detail: "守护进程没有心跳记录" },
      ],
    };
    expect(patrolSignature(ops)).toBe("config:repos|daemon:heartbeat");
    patrol.tick();
    expect(got).toHaveLength(2);
    patrol.tick();
    expect(got).toHaveLength(2);
  });

  test("身份缺省回落到 scheduler；关闭时 start 不启动", () => {
    const { store } = memStore();
    const got: IncomingMessage[] = [];
    const ops = { exitCode: 1 as const, label: "需重启", issues: [{ code: 1 as const, key: "daemon:heartbeat", detail: "x" }] };
    const patrol = new StatusPatrol({
      cfg: cfg({ scheduler: { chatId: "c2", userId: "u2" } }),
      store,
      enqueue: (m) => void got.push(m),
      evaluate: () => ops,
      now: () => NOW,
    });
    patrol.tick();
    expect(got[0]!.chatId).toBe("c2");

    const off = new StatusPatrol({
      cfg: cfg({ proactive: { patrol: { enabled: false, chatId: "c1", userId: "u1" } } }),
      store: memStore().store,
      enqueue: (m) => void got.push(m),
      evaluate: () => ops,
    });
    off.start();
    off.stop();
    expect(got).toHaveLength(1);
  });
});
