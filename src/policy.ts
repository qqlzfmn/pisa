import { createHash } from "node:crypto";

/** 派活来源：按入口归类，各自的权限面不同 */
export type PolicySource = "im" | "github" | "webhook" | "cron" | "proactive";

/**
 * 执行档位：
 * - `off`：该来源一律不接单
 * - `observe`：一律接单，只记录矩阵判定（灰度用）
 * - `auto`：按四格矩阵执行
 */
export type AcceptMode = "off" | "observe" | "auto";

/** 准入矩阵的四格：名单内外 × 是否 @ */
export type AdmissionCell = "inMention" | "inPlain" | "outMention" | "outPlain";

export type CellVerdict = "accept" | "deny";

/** 一个来源的配置；缺省字段取该来源的默认值 */
export interface SourcePolicyConfig {
  /** 来源开关：false 时一律不接单（优先于档位） */
  allowed?: boolean;
  /** 该来源可派活的主体；缺省沿用 whitelist.users */
  principals?: string[];
  /** 四格判定；未配置的格取该来源默认值 */
  cells?: Partial<Record<AdmissionCell, CellVerdict>>;
  accept?: AcceptMode;
}

export interface PolicyConfig {
  sources?: Partial<Record<PolicySource, SourcePolicyConfig>>;
}

/** 归一化后的来源策略：每个字段都有确定取值 */
export interface SourcePolicy {
  allowed: boolean;
  principals: string[];
  cells: Record<AdmissionCell, CellVerdict>;
  accept: AcceptMode;
}

export interface EffectivePolicy {
  /** 配置内容哈希的前 8 位；同一配置恒等 */
  version: string;
  sources: Record<PolicySource, SourcePolicy>;
}

export interface AdmissionRequest {
  source: PolicySource;
  /** 实际派活主体：IM 是 telegram user id，GitHub 是评论作者 login，探针是配置身份 */
  principal: string;
  /** 是否明确点名 pisa：私聊、带触发词、评论正文、探针与 cron 为真；关键词误触为假 */
  mentioned: boolean;
}

/** 一次派活的授权记录：任务落库时写入，恢复前据此重校验 */
export interface Mandate {
  source: PolicySource;
  principal: string;
  listed: boolean;
  mentioned: boolean;
  cell: AdmissionCell;
  /** 矩阵判定；observe 档位下也照常记录 */
  verdict: CellVerdict;
  /** 当时的执行档位 */
  mode: AcceptMode;
  /** 实际处置 */
  outcome: "accept" | "observe" | "deny";
  policyVersion: string;
  /** 拒绝或降级的原因；正常接单为 null */
  reason: string | null;
}

export const POLICY_SOURCES: readonly PolicySource[] = ["im", "github", "webhook", "cron", "proactive"];

const CELLS: readonly AdmissionCell[] = ["inMention", "inPlain", "outMention", "outPlain"];

const SOURCE_LABEL: Record<PolicySource, string> = {
  im: "IM",
  github: "GitHub",
  webhook: "webhook",
  cron: "定时",
  proactive: "主动发现",
};

const CELL_LABEL: Record<AdmissionCell, string> = {
  inMention: "名单内@",
  inPlain: "名单内未@",
  outMention: "名单外@",
  outPlain: "名单外未@",
};

const OUTCOME_LABEL: Record<Mandate["outcome"], string> = {
  accept: "接受",
  observe: "观察",
  deny: "拒绝",
};

/**
 * 来源默认值等于改造前的行为：
 * - IM 认白名单主体，名单外一律不接（原 checkAccess 语义）
 * - GitHub / webhook / cron / 主动发现原先不看派活主体，默认四格全接受；
 *   要收紧就在配置里改具体的格
 */
const DEFAULT_CELLS: Record<PolicySource, Record<AdmissionCell, CellVerdict>> = {
  im: { inMention: "accept", inPlain: "accept", outMention: "deny", outPlain: "deny" },
  github: { inMention: "accept", inPlain: "accept", outMention: "accept", outPlain: "accept" },
  webhook: { inMention: "accept", inPlain: "accept", outMention: "accept", outPlain: "accept" },
  cron: { inMention: "accept", inPlain: "accept", outMention: "accept", outPlain: "accept" },
  proactive: { inMention: "accept", inPlain: "accept", outMention: "accept", outPlain: "accept" },
};

/** 配置 + 仓库白名单 → 每个来源都有确定取值的策略，并算出版本 */
export function effectivePolicy(policy: PolicyConfig | undefined, whitelistUsers: readonly string[]): EffectivePolicy {
  const sources = {} as Record<PolicySource, SourcePolicy>;
  for (const source of POLICY_SOURCES) {
    const patch = policy?.sources?.[source];
    const cells = {} as Record<AdmissionCell, CellVerdict>;
    for (const cell of CELLS) cells[cell] = patch?.cells?.[cell] ?? DEFAULT_CELLS[source][cell];
    sources[source] = {
      allowed: patch?.allowed ?? true,
      principals: [...(patch?.principals ?? whitelistUsers)].sort(),
      cells,
      accept: patch?.accept ?? "auto",
    };
  }
  return { version: policyVersion(sources), sources };
}

/** 规范化 JSON 的内容哈希：字段顺序固定，配置一变版本就变 */
function policyVersion(sources: Record<PolicySource, SourcePolicy>): string {
  const canonical = POLICY_SOURCES.map((source) => {
    const p = sources[source];
    return [source, p.allowed, p.principals, CELLS.map((c) => p.cells[c]), p.accept];
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 8);
}

/** 准入判定：纯函数，不读配置、不碰存储 */
export function decideAdmission(policy: EffectivePolicy, req: AdmissionRequest): Mandate {
  const source = policy.sources[req.source];
  const listed = source.principals.includes(req.principal);
  const cell: AdmissionCell = listed
    ? req.mentioned
      ? "inMention"
      : "inPlain"
    : req.mentioned
      ? "outMention"
      : "outPlain";
  const verdict = source.cells[cell];
  const base = {
    source: req.source,
    principal: req.principal,
    listed,
    mentioned: req.mentioned,
    cell,
    verdict,
    mode: source.accept,
    policyVersion: policy.version,
  };
  if (!source.allowed) {
    return { ...base, outcome: "deny", reason: `来源 ${SOURCE_LABEL[req.source]} 已关闭（allowed=false）` };
  }
  if (source.accept === "off") {
    return { ...base, outcome: "deny", reason: `来源 ${SOURCE_LABEL[req.source]} 的档位为 off` };
  }
  if (source.accept === "observe") {
    return { ...base, outcome: "observe", reason: null };
  }
  if (verdict === "deny") {
    return {
      ...base,
      outcome: "deny",
      reason: `来源 ${SOURCE_LABEL[req.source]} 的「${CELL_LABEL[cell]}」判定为拒绝（主体 ${req.principal || "未知"}）`,
    };
  }
  return { ...base, outcome: "accept", reason: null };
}

/** 一行说清一次授权：来源 · 主体 · 命中格 · 处置 · 策略版本 */
export function formatMandate(m: Mandate): string {
  return `${SOURCE_LABEL[m.source]} · ${m.principal || "未知"} · ${CELL_LABEL[m.cell]} · ${OUTCOME_LABEL[m.outcome]} · 策略 ${m.policyVersion}`;
}

/** `/pisa policy` 的输出：当前策略与版本一次看全 */
export function formatPolicy(policy: EffectivePolicy): string {
  const lines = [
    `准入策略 · 版本 ${policy.version}（配置内容哈希：改配置即变；已接任务不追溯，恢复前重校验）`,
  ];
  for (const source of POLICY_SOURCES) {
    const p = policy.sources[source];
    const open = CELLS.every((c) => p.cells[c] === "accept");
    const names = open ? "不限" : p.principals.length > 0 ? p.principals.join(",") : "(空)";
    lines.push(`${source} · ${p.allowed ? "开" : "关"} · ${p.accept} · 名单 ${names}`);
    lines.push(`  ${CELLS.map((c) => `${CELL_LABEL[c]}${p.cells[c] === "accept" ? "接受" : "拒绝"}`).join(" · ")}`);
  }
  lines.push("名单缺省沿用 whitelist.users；auto 按四格执行，observe 只记账不拦截，off 全部拒绝。");
  return lines.join("\n");
}
