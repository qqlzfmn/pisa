import { describe, expect, test } from "bun:test";
import { decide, formatPolicy, policySnapshot, recheck, admissionSubject } from "../src/policy";
import type { Config } from "../src/config";
import type { IncomingMessage } from "../src/types";

function makeCfg(over: Partial<Config> = {}): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: false,
    whitelist: { users: ["u1"], repos: [] },
    repos: [],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: {},
    stateDir: "/tmp/pisa-policy-test",
    ...over,
  };
}

function msg(over: Partial<IncomingMessage> = {}): IncomingMessage {
  return { eventId: "e1", channel: "fake", chatId: "c1", userId: "u1", text: "/pisa 做事", ...over };
}

describe("policy 判定", () => {
  test("未配置策略时沿用白名单：名单内放行，外拒绝", () => {
    const policy = policySnapshot(makeCfg());
    expect(decide(policy, { source: "fake", subject: "u1", mentioned: false })).toMatchObject({
      listed: true,
      cell: "listed.plain",
      accept: "auto",
      allowed: true,
      reason: null,
    });
    const out = decide(policy, { source: "fake", subject: "stranger", mentioned: true });
    expect(out).toMatchObject({ listed: false, cell: "unlisted.mention", allowed: false });
    expect(out.reason).toContain("无权限");
  });

  test("四格各自生效：名单内未 @ 可拒绝，名单外 @ 可放行", () => {
    const cfg = makeCfg({
      policy: {
        sources: {
          fake: {
            allowed: ["u1"],
            cells: { listed: { plain: "deny" }, unlisted: { mention: "allow" } },
          },
        },
      },
    });
    const policy = policySnapshot(cfg);
    const gate = (subject: string, mentioned: boolean) => decide(policy, { source: "fake", subject, mentioned });

    expect(gate("u1", true).allowed).toBe(true);
    const denied = gate("u1", false);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("listed.plain=deny");
    expect(gate("guest", true).allowed).toBe(true);
    expect(gate("guest", false).allowed).toBe(false);
  });

  test("accept=off 不接单，observe 放行但标记观察", () => {
    const off = policySnapshot(makeCfg({ policy: { sources: { fake: { accept: "off" } } } }));
    const refused = decide(off, { source: "fake", subject: "u1", mentioned: false });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("accept=off");

    const observe = policySnapshot(makeCfg({ policy: { sources: { fake: { accept: "observe" } } } }));
    expect(decide(observe, { source: "fake", subject: "u1", mentioned: false })).toMatchObject({
      allowed: true,
      accept: "observe",
    });
  });

  test("版本只随规则内容变化", () => {
    const a = policySnapshot(makeCfg());
    const b = policySnapshot(makeCfg({ trigger: "/other" }));
    expect(b.version).toBe(a.version);

    const tightened = policySnapshot(makeCfg({ policy: { sources: { fake: { allowed: ["u1", "u2"] } } } }));
    expect(tightened.version).not.toBe(a.version);
    expect(tightened.version).toMatch(/^[0-9a-f]{12}$/);
  });

  test("配置了策略的群聊入口按真实发起人判定，名单缺省取入口白名单", () => {
    const cfg = makeCfg({
      policy: { sources: { feishu: {} } },
      triggers: { feishu: { enabled: true, secretEnv: "S", users: ["ou_owner"] } },
    });
    const policy = policySnapshot(cfg);
    // 投递身份是配置的 bot，真实发起人不在名单
    expect(admissionSubject(policy, msg({ channel: "feishu", userId: "bot", actor: "ou_stranger" }))).toBe(
      "ou_stranger",
    );
    expect(decide(policy, { source: "feishu", subject: "ou_stranger", mentioned: false }).allowed).toBe(false);
    expect(decide(policy, { source: "feishu", subject: "ou_owner", mentioned: true }).allowed).toBe(true);

    // 没配策略时保持旧行为：仍按 userId 判定
    const legacy = policySnapshot(makeCfg({ triggers: { feishu: { enabled: true, secretEnv: "S" } } }));
    expect(admissionSubject(legacy, msg({ channel: "feishu", userId: "bot", actor: "ou_stranger" }))).toBe("bot");
  });
});

describe("policy 恢复重校验", () => {
  test("策略未变时放行", () => {
    const policy = policySnapshot(makeCfg());
    expect(recheck(policy, { source: "fake", subject: "u1", mentioned: false, previousVersion: policy.version })).toMatchObject({
      ok: true,
      changed: false,
      reason: null,
    });
  });

  test("被移出名单后拒绝恢复，并指出接单时版本", () => {
    const before = policySnapshot(makeCfg());
    const after = policySnapshot(makeCfg({ whitelist: { users: [], repos: [] } }));
    const r = recheck(after, {
      source: "fake",
      subject: "u1",
      mentioned: false,
      previousVersion: before.version,
    });
    expect(r.ok).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.reason).toContain("拒绝恢复");
    expect(r.reason).toContain(before.version);
  });

  test("来源降为 observe/off 时不恢复执行", () => {
    const before = policySnapshot(makeCfg());
    for (const accept of ["observe", "off"] as const) {
      const after = policySnapshot(makeCfg({ policy: { sources: { fake: { accept } } } }));
      const r = recheck(after, { source: "fake", subject: "u1", mentioned: false, previousVersion: before.version });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(accept);
    }
  });

  test("格从 allow 收紧为 deny 后拒绝恢复", () => {
    const before = policySnapshot(makeCfg());
    const after = policySnapshot(makeCfg({ policy: { sources: { fake: { cells: { listed: { plain: "deny" } } } } } }));
    const r = recheck(after, { source: "fake", subject: "u1", mentioned: false, previousVersion: before.version });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("listed.plain=deny");
  });
});

describe("policy 展示", () => {
  test("列出每个来源的规则与版本，并附 observe 记录", () => {
    const policy = policySnapshot(makeCfg({ policy: { sources: { webhook: { accept: "observe" } } } }));
    const text = formatPolicy(policy, [
      {
        eventId: "webhook:1",
        source: "webhook",
        subject: "ci",
        cell: "unlisted.plain",
        accept: "observe",
        policyVersion: policy.version,
        prompt: "跑一下全量测试",
        at: 1_700_000_000_000,
      },
    ]);
    expect(text).toContain(`准入策略 · version ${policy.version}`);
    expect(text).toContain("webhook · accept=observe");
    expect(text).toContain("telegram · accept=auto");
    expect(text).toContain("listed @=allow 未@=allow");
    expect(text).toContain("observe 记录（最近 1 条）");
    expect(text).toContain("跑一下全量测试");
  });
});
