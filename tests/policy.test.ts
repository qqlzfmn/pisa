import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SOURCE_POLICY,
  admit,
  formatPolicy,
  mandateOf,
  policyVersion,
  policyWarnings,
  resolvePolicy,
  sanitizePolicy,
  type PolicyInput,
} from "../src/policy";

const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  whitelist: { users: ["u1"], repos: ["demo"] },
  ...over,
});

describe("默认策略", () => {
  test("名单内点名与未点名都放行，名单外都拒绝", () => {
    const listed = admit(input(), { source: "telegram", listed: true, mentioned: true });
    expect(listed).toMatchObject({ admitted: true, execute: true, mode: "auto", cell: "listed:mentioned" });
    expect(listed.reason).toBe("");
    expect(admit(input(), { source: "telegram", listed: true, mentioned: false }).execute).toBe(true);

    const unlistedPlain = admit(input(), { source: "telegram", listed: false, mentioned: false });
    expect(unlistedPlain.execute).toBe(false);
    expect(unlistedPlain.reason).toContain("无权限");
    expect(unlistedPlain.reason).toContain("没有点名");
    expect(admit(input(), { source: "telegram", listed: false, mentioned: true }).cell).toBe("unlisted:mentioned");
  });

  test("未知来源沿用默认值", () => {
    expect(resolvePolicy(undefined, "imap")).toEqual(DEFAULT_SOURCE_POLICY);
  });

  test("本地 CLI 默认名单外也放行", () => {
    const cli = admit(input(), { source: "cli", listed: false, mentioned: true });
    expect(cli.execute).toBe(true);
    expect(cli.mode).toBe("auto");
  });
});

describe("来源覆盖", () => {
  const policy = {
    telegram: {
      allowed: true,
      accept: "auto" as const,
      admission: { listed: { plain: false }, unlisted: { mentioned: true } },
    },
  };

  test("部分字段合并到默认值", () => {
    const resolved = resolvePolicy(policy, "telegram");
    expect(resolved.admission.listed).toEqual({ mentioned: true, plain: false });
    expect(resolved.admission.unlisted).toEqual({ mentioned: true, plain: false });
    expect(admit(input({ policy }), { source: "telegram", listed: true, mentioned: false }).execute).toBe(false);
    expect(admit(input({ policy }), { source: "telegram", listed: false, mentioned: true }).execute).toBe(true);
    // 未配置的来源不受影响
    expect(admit(input({ policy }), { source: "webhook", listed: false, mentioned: false }).execute).toBe(false);
  });

  test("allowed=false 拒绝整个来源", () => {
    const verdict = admit(input({ policy: { webhook: { allowed: false } } }), {
      source: "webhook",
      listed: true,
      mentioned: true,
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.execute).toBe(false);
    expect(verdict.reason).toContain("无权限");
    expect(verdict.reason).toContain("allowed=false");
  });

  test("accept=off 拒单，accept=observe 接单但不执行", () => {
    const off = admit(input({ policy: { github: { accept: "off" } } }), { source: "github", listed: true, mentioned: true });
    expect(off.execute).toBe(false);
    expect(off.reason).toContain("暂停接单");

    const observe = admit(input({ policy: { github: { accept: "observe" } } }), {
      source: "github",
      listed: true,
      mentioned: true,
    });
    expect(observe).toMatchObject({ admitted: true, execute: false, mode: "observe" });
    expect(observe.reason).toContain("观察模式");
  });
});

describe("配置校验", () => {
  test("非法取值回落到默认并告警", () => {
    const raw = { telegram: { accept: "sometimes", allowed: "yes", extra: 1 } } as unknown as Parameters<
      typeof sanitizePolicy
    >[0];
    const { policy, warnings } = sanitizePolicy(raw);
    expect(policy.telegram).toEqual({});
    expect(warnings.join("\n")).toContain("accept 只能是 off/observe/auto");
    expect(warnings.join("\n")).toContain("allowed 必须是布尔值");
    expect(warnings.join("\n")).toContain("未知字段");
    expect(policyWarnings(raw).length).toBe(3);
  });

  test("非对象输入不崩溃", () => {
    expect(policyWarnings([] as unknown as Parameters<typeof sanitizePolicy>[0])).toEqual(["policy 必须是对象，已忽略"]);
    const cells = sanitizePolicy({ cron: { admission: { listed: { mentioned: "yes" } } } as never });
    expect(cells.warnings.join("\n")).toContain("必须是布尔值");
    expect(cells.policy.cron?.admission?.listed).toEqual({});
  });
});

describe("策略版本", () => {
  test("同一策略版本稳定，书写顺序不影响", () => {
    const a = policyVersion(input({ policy: { telegram: { accept: "observe" }, cron: { allowed: false } } }));
    const b = policyVersion(input({ policy: { cron: { allowed: false }, telegram: { accept: "observe" } } }));
    expect(a).toBe(b);
    expect(a).toMatch(/^p-[0-9a-f]{12}$/);
  });

  test("白名单用户或来源策略变化会改变版本", () => {
    const base = policyVersion(input());
    expect(policyVersion(input({ whitelist: { users: ["u1", "u2"], repos: ["demo"] } }))).not.toBe(base);
    expect(policyVersion(input({ policy: { telegram: { accept: "observe" } } }))).not.toBe(base);
    // 仓库白名单不影响准入判定，也不该影响版本
    expect(policyVersion(input({ whitelist: { users: ["u1"], repos: ["other"] } }))).toBe(base);
  });
});

describe("展示与凭据", () => {
  test("formatPolicy 列出每个来源的四格与版本", () => {
    const text = formatPolicy(input({ policy: { github: { accept: "off" } } }));
    expect(text).toContain(policyVersion(input({ policy: { github: { accept: "off" } } })));
    expect(text).toContain("白名单用户：u1");
    expect(text).toContain("白名单仓库：demo");
    expect(text).toContain("telegram · 开放 · auto");
    expect(text).toContain("github · 开放 · off");
    expect(text).toContain("名单内：点名 放行 · 未点名 放行");
    expect(text).toContain("名单外：点名 拒绝 · 未点名 拒绝");
    expect(text).toContain("webhook");
  });

  test("mandateOf 固化判定所用的事实", () => {
    const request = { source: "telegram", listed: false, mentioned: true };
    const verdict = admit(input({ policy: { telegram: { admission: { unlisted: { mentioned: true } } } } }), request);
    expect(mandateOf(request, verdict)).toEqual({
      source: "telegram",
      listed: false,
      mentioned: true,
      cell: "unlisted:mentioned",
      mode: "auto",
    });
  });
});
