import { describe, expect, test } from "bun:test";
import {
  admit,
  formatPolicy,
  mandateOf,
  policyVersion,
  sourcePolicy,
  type PolicyConfig,
  type PolicyHost,
} from "../src/policy";

function host(policy?: PolicyConfig, users = ["u1"], repos = ["demo"]): PolicyHost {
  return { whitelist: { users, repos }, policy };
}

describe("sourcePolicy", () => {
  test("未配置的来源取默认：名单内放行、名单外拒绝", () => {
    const p = sourcePolicy(undefined, "telegram");
    expect(p).toEqual({
      allowed: true,
      accept: "auto",
      admission: {
        member: { addressed: "allow", unaddressed: "allow" },
        outsider: { addressed: "deny", unaddressed: "deny" },
      },
    });
  });

  test("只覆盖写到的格子，其余保持默认", () => {
    const p = sourcePolicy({ sources: { web: { admission: { outsider: { addressed: "allow" } } } } }, "web");
    expect(p.admission.outsider.addressed).toBe("allow");
    expect(p.admission.outsider.unaddressed).toBe("deny");
    expect(p.admission.member.addressed).toBe("allow");
    expect(p.accept).toBe("auto");
  });
});

describe("admit", () => {
  test("名单内用户点名派活放行，并记录策略版本", () => {
    const a = admit(host(), { source: "telegram", requester: "u1", addressed: true });
    expect(a.reason).toBeNull();
    expect(a.audience).toBe("member");
    expect(a.addressing).toBe("addressed");
    expect(a.verdict).toBe("allow");
    expect(a.version).toBe(policyVersion(host()));
  });

  test("名单外用户点名派活按默认拒绝，原因带版本", () => {
    const a = admit(host(), { source: "telegram", requester: "stranger", addressed: true });
    expect(a.audience).toBe("outsider");
    expect(a.reason).toContain("无权限");
    expect(a.reason).toContain("名单外用户");
    expect(a.reason).toContain(`策略版本 ${a.version}`);
  });

  test("名单外未点名可以按配置放行", () => {
    const cfg: PolicyConfig = { sources: { webhook: { admission: { outsider: { unaddressed: "allow" } } } } };
    const a = admit(host(cfg), { source: "webhook", requester: "ci", addressed: false });
    expect(a.reason).toBeNull();
    expect(a.verdict).toBe("allow");
  });

  test("allowed=false 时任何人任何点法都拒绝", () => {
    const a = admit(host({ sources: { github: { allowed: false } } }), {
      source: "github",
      requester: "u1",
      addressed: true,
    });
    expect(a.reason).toContain("未开放");
  });

  test("off 模式全拒，即使准入表允许", () => {
    const a = admit(host({ sources: { cron: { accept: "off" } } }), {
      source: "cron",
      requester: "u1",
      addressed: true,
    });
    expect(a.reason).toContain("off");
    expect(a.verdict).toBe("allow");
  });

  test("observe 模式放行但保留拒绝裁决", () => {
    const a = admit(host({ sources: { web: { accept: "observe" } } }), {
      source: "web",
      requester: "stranger",
      addressed: true,
    });
    expect(a.reason).toBeNull();
    expect(a.mode).toBe("observe");
    expect(a.verdict).toBe("deny");
  });

  test("mandate 固化裁决，可用于恢复前对照", () => {
    const a = admit(host(), { source: "telegram", requester: "u1", addressed: true });
    const m = mandateOf(a, "u1", 123);
    expect(m).toMatchObject({
      source: "telegram",
      requester: "u1",
      audience: "member",
      addressing: "addressed",
      verdict: "allow",
      mode: "auto",
      version: a.version,
      at: 123,
    });
  });
});

describe("policyVersion", () => {
  test("是 12 位十六进制指纹", () => {
    expect(policyVersion(host())).toMatch(/^[0-9a-f]{12}$/);
  });

  test("同一策略顺序无关、结果稳定", () => {
    const a = host({ sources: { web: { accept: "auto" }, telegram: { accept: "auto" } } }, ["u2", "u1"], ["b", "a"]);
    const b = host({ sources: { telegram: { accept: "auto" }, web: { accept: "auto" } } }, ["u1", "u2"], ["a", "b"]);
    expect(policyVersion(a)).toBe(policyVersion(b));
  });

  test("改名单或来源策略都会换版本", () => {
    const base = policyVersion(host());
    expect(policyVersion(host(undefined, ["u1", "u2"]))).not.toBe(base);
    expect(policyVersion(host(undefined, ["u1"], ["demo", "other"]))).not.toBe(base);
    expect(policyVersion(host({ sources: { fake: { accept: "observe" } } }))).not.toBe(base);
  });
});

describe("formatPolicy", () => {
  test("无覆盖时给出默认四格与版本", () => {
    const text = formatPolicy(host());
    expect(text).toContain(`准入策略 · 版本 ${policyVersion(host())}`);
    expect(text).toContain("名单内·点名");
    expect(text).toContain("名单外·未点名");
    expect(text).toContain("默认策略");
  });

  test("有覆盖时按来源列出开关与模式", () => {
    const cfg: PolicyConfig = {
      sources: {
        github: { allowed: false },
        web: { accept: "observe", admission: { outsider: { unaddressed: "allow" } } },
      },
    };
    const text = formatPolicy(host(cfg));
    expect(text).toContain("github · 关闭（allowed=false）");
    expect(text).toContain("web · 开放 · observe（记录裁决但放行）");
    expect(text).toContain("名单外·未点名：放行");
  });
});
