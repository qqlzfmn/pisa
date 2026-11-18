import { createHash } from "node:crypto";

/**
 * 来源准入：谁能派活由「来源 × 名单内外 × 是否点名」决定。
 * 策略配置只是覆盖层，缺省值保持白名单时代的语义：名单内放行、名单外拒绝。
 */

export type AcceptMode = "off" | "observe" | "auto";
export type Audience = "member" | "outsider";
export type Addressing = "addressed" | "unaddressed";
export type CellRule = "allow" | "deny";

export interface AdmissionCells {
  member: Record<Addressing, CellRule>;
  outsider: Record<Addressing, CellRule>;
}

/** 单个来源的完整策略；`allowed` 与 `accept` 是先决开关，准入表只在 auto 下生效 */
export interface SourcePolicy {
  allowed: boolean;
  accept: AcceptMode;
  admission: AdmissionCells;
}

/** 配置里的来源策略：只写要覆盖的字段，其余取默认 */
export interface SourcePolicyConfig {
  allowed?: boolean;
  accept?: AcceptMode;
  admission?: {
    member?: Partial<Record<Addressing, CellRule>>;
    outsider?: Partial<Record<Addressing, CellRule>>;
  };
}

export interface PolicyConfig {
  sources?: Record<string, SourcePolicyConfig>;
}

/** 准入只看用户名单；仓库名单由 Router 的仓库校验负责，二者同属策略版本 */
export interface PolicyHost {
  whitelist: { users: string[]; repos: string[] };
  policy?: PolicyConfig;
}

export const DEFAULT_ADMISSION: AdmissionCells = {
  member: { addressed: "allow", unaddressed: "allow" },
  outsider: { addressed: "deny", unaddressed: "deny" },
};

export const DEFAULT_SOURCE_POLICY: SourcePolicy = {
  allowed: true,
  accept: "auto",
  admission: DEFAULT_ADMISSION,
};

function cloneDefault(): SourcePolicy {
  return {
    allowed: DEFAULT_SOURCE_POLICY.allowed,
    accept: DEFAULT_SOURCE_POLICY.accept,
    admission: {
      member: { ...DEFAULT_ADMISSION.member },
      outsider: { ...DEFAULT_ADMISSION.outsider },
    },
  };
}

/** 合并一个来源的配置；未配置的来源返回默认策略 */
export function sourcePolicy(cfg: PolicyConfig | undefined, source: string): SourcePolicy {
  const raw = cfg?.sources?.[source];
  const base = cloneDefault();
  if (!raw) return base;
  return {
    allowed: raw.allowed ?? base.allowed,
    accept: raw.accept ?? base.accept,
    admission: {
      member: { ...base.admission.member, ...(raw.admission?.member ?? {}) },
      outsider: { ...base.admission.outsider, ...(raw.admission?.outsider ?? {}) },
    },
  };
}

/** 稳定序列化：策略版本不能被对象键顺序影响 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 策略版本：白名单与所有已配置来源的生效策略的指纹，配置一改版本就变 */
export function policyVersion(host: PolicyHost): string {
  const sources: Record<string, SourcePolicy> = {};
  for (const name of Object.keys(host.policy?.sources ?? {}).sort()) sources[name] = sourcePolicy(host.policy, name);
  const body = canonical({
    users: [...host.whitelist.users].sort(),
    repos: [...host.whitelist.repos].sort(),
    sources,
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

export interface Admission {
  source: string;
  audience: Audience;
  addressing: Addressing;
  /** 准入表本身的裁决；observe 模式下 deny 也会放行 */
  verdict: CellRule;
  mode: AcceptMode;
  version: string;
  /** null 表示放行；否则是给用户的拒绝原因 */
  reason: string | null;
}

/**
 * 一次准入裁决。顺序固定：来源开关 → accept 模式 → 准入表。
 * observe 放行但记录 verdict，供日志与 /pisa policy 观察；off 一律拒绝。
 */
export function admit(host: PolicyHost, input: { source: string; requester: string; addressed: boolean }): Admission {
  const policy = sourcePolicy(host.policy, input.source);
  const audience: Audience = host.whitelist.users.includes(input.requester) ? "member" : "outsider";
  const addressing: Addressing = input.addressed ? "addressed" : "unaddressed";
  const verdict = policy.admission[audience][addressing];
  const version = policyVersion(host);
  const who = audience === "member" ? "名单内用户" : "名单外用户";
  const how = addressing === "addressed" ? "点名派活" : "未点名派活";

  let reason: string | null = null;
  if (!policy.allowed) {
    reason = `无权限：来源 ${input.source} 未开放派活。`;
  } else if (policy.accept === "off") {
    reason = `无权限：来源 ${input.source} 的准入模式为 off。`;
  } else if (policy.accept === "auto" && verdict === "deny") {
    reason = `无权限：当前准入策略不允许${who}在来源 ${input.source} ${how}。`;
  }
  if (reason) reason += `（策略版本 ${version}）`;

  return { source: input.source, audience, addressing, verdict, mode: policy.accept, version, reason };
}

/** 任务落库的准入快照：之后的策略变更不追溯它，恢复时拿它对照当前策略 */
export interface Mandate {
  source: string;
  requester: string;
  audience: Audience;
  addressing: Addressing;
  verdict: CellRule;
  mode: AcceptMode;
  version: string;
  at: number;
}

export function mandateOf(admission: Admission, requester: string, at: number): Mandate {
  return {
    source: admission.source,
    requester,
    audience: admission.audience,
    addressing: admission.addressing,
    verdict: admission.verdict,
    mode: admission.mode,
    version: admission.version,
    at,
  };
}

const MODE_LABEL: Record<AcceptMode, string> = {
  off: "off（全部拒绝）",
  observe: "observe（记录裁决但放行）",
  auto: "auto（按准入表执行）",
};

const CELL_LABEL: Record<CellRule, string> = { allow: "放行", deny: "拒绝" };

function cellLine(audience: Audience, addressing: Addressing, rule: CellRule): string {
  const who = audience === "member" ? "名单内" : "名单外";
  const how = addressing === "addressed" ? "点名" : "未点名";
  return `  ${who}·${how}：${CELL_LABEL[rule]}`;
}

/** `/pisa policy` 的正文：当前规则与版本，一眼能看出谁被拦 */
export function formatPolicy(host: PolicyHost): string {
  const lines = [
    `准入策略 · 版本 ${policyVersion(host)}`,
    "判断顺序：来源开关 → accept 模式 → 名单内外 × 是否点名。",
    "策略变更不追溯已有任务；恢复暂停任务前按当前版本重校验。",
    `名单：用户 ${host.whitelist.users.join("、") || "(空)"}；仓库 ${host.whitelist.repos.join("、") || "(空)"}`,
  ];

  const names = Object.keys(host.policy?.sources ?? {}).sort();
  if (names.length === 0) {
    lines.push("", "未配置来源覆盖，所有来源使用默认策略：");
    const p = cloneDefault();
    lines.push(cellLine("member", "addressed", p.admission.member.addressed));
    lines.push(cellLine("member", "unaddressed", p.admission.member.unaddressed));
    lines.push(cellLine("outsider", "addressed", p.admission.outsider.addressed));
    lines.push(cellLine("outsider", "unaddressed", p.admission.outsider.unaddressed));
    return lines.join("\n");
  }

  for (const name of names) {
    const p = sourcePolicy(host.policy, name);
    lines.push("", `${name} · ${p.allowed ? "开放" : "关闭（allowed=false）"} · ${MODE_LABEL[p.accept]}`);
    if (!p.allowed) continue;
    lines.push(cellLine("member", "addressed", p.admission.member.addressed));
    lines.push(cellLine("member", "unaddressed", p.admission.member.unaddressed));
    lines.push(cellLine("outsider", "addressed", p.admission.outsider.addressed));
    lines.push(cellLine("outsider", "unaddressed", p.admission.outsider.unaddressed));
  }
  return lines.join("\n");
}
