import { createHash } from "node:crypto";

/** 接单模式：off 不接；observe 记录判定但不建任务；auto 正常接单 */
export type AcceptMode = "off" | "observe" | "auto";

/** 准入格的两个轴：身份在不在白名单、这条消息有没有点名 pisa */
export interface AdmissionCells {
  listed: { mentioned: boolean; plain: boolean };
  unlisted: { mentioned: boolean; plain: boolean };
}

export type AdmissionCellKey = "listed:mentioned" | "listed:plain" | "unlisted:mentioned" | "unlisted:plain";

export interface SourcePolicy {
  allowed: boolean;
  accept: AcceptMode;
  admission: AdmissionCells;
}

/** 配置里单来源的覆盖：缺省字段落到该来源的默认值 */
export interface SourcePolicyPatch {
  allowed?: boolean;
  accept?: AcceptMode;
  admission?: {
    listed?: Partial<AdmissionCells["listed"]>;
    unlisted?: Partial<AdmissionCells["unlisted"]>;
  };
}

/** 来源 → 覆盖；来源是渠道名，开放字符串以便新增入口 */
export type PolicyConfig = Record<string, SourcePolicyPatch>;

/** 建单时的准入凭据：之后不再随配置变化 */
export interface Mandate {
  source: string;
  listed: boolean;
  mentioned: boolean;
  cell: AdmissionCellKey;
  mode: AcceptMode;
}

/** 判定所需的配置面：来源策略与用户白名单 */
export interface PolicyInput {
  policy?: PolicyConfig;
  whitelist?: { users: string[]; repos?: string[] };
}

export interface AdmissionVerdict {
  /** 是否接单：观察模式也算接单，只是不执行 */
  admitted: boolean;
  /** 是否建任务并执行 */
  execute: boolean;
  mode: AcceptMode;
  cell: AdmissionCellKey;
  /** 拒绝或观察的说明；放行时为空串 */
  reason: string;
}

/** 已知来源：/pisa policy 按此顺序展示；配置里新增的来源排在后面 */
export const KNOWN_SOURCES: readonly string[] = ["telegram", "cli", "web", "webhook", "github", "cron", "proactive"];

/** 其余来源共用：名单内放行、名单外拒绝、自动接单（与引入 policy 之前一致） */
export const DEFAULT_SOURCE_POLICY: SourcePolicy = {
  allowed: true,
  accept: "auto",
  admission: { listed: { mentioned: true, plain: true }, unlisted: { mentioned: false, plain: false } },
};

/**
 * 来源默认值的例外：本地 CLI 直接写状态库、不经 Router，运行者本来就有完整权限，
 * 默认名单内外都放行（名单只约束对话通道）。
 */
const SOURCE_DEFAULTS: Record<string, SourcePolicy> = {
  cli: {
    allowed: true,
    accept: "auto",
    admission: { listed: { mentioned: true, plain: true }, unlisted: { mentioned: true, plain: true } },
  },
};

const ACCEPT_MODES: Record<AcceptMode, true> = { off: true, observe: true, auto: true };
const PATCH_FIELDS: Record<string, true> = { allowed: true, accept: true, admission: true };
const ADMISSION_FIELDS: Record<string, true> = { listed: true, unlisted: true };
const CELL_FIELDS: Record<string, true> = { mentioned: true, plain: true };

function isAcceptMode(v: unknown): v is AcceptMode {
  return typeof v === "string" && Object.hasOwn(ACCEPT_MODES, v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 逐格校验：非法值丢弃并留下告警，启动不因此失败 */
function sanitizeCells(name: string, raw: unknown, warnings: string[]): Partial<AdmissionCells["listed"]> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    warnings.push(`policy.${name} 不是对象，已忽略`);
    return undefined;
  }
  const cells: Partial<AdmissionCells["listed"]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(CELL_FIELDS, key)) {
      warnings.push(`policy.${name}.${key} 是未知字段，已忽略`);
    } else if (typeof value === "boolean") {
      cells[key as keyof AdmissionCells["listed"]] = value;
    } else {
      warnings.push(`policy.${name}.${key} 必须是布尔值，已忽略`);
    }
  }
  return cells;
}

function sanitizeAdmission(source: string, raw: unknown, warnings: string[]): SourcePolicyPatch["admission"] {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    warnings.push(`policy.${source}.admission 不是对象，已忽略`);
    return undefined;
  }
  const admission: NonNullable<SourcePolicyPatch["admission"]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(ADMISSION_FIELDS, key)) {
      warnings.push(`policy.${source}.admission.${key} 是未知字段，已忽略`);
      continue;
    }
    const cells = sanitizeCells(`${source}.admission.${key}`, value, warnings);
    if (cells) admission[key as "listed" | "unlisted"] = cells;
  }
  return admission;
}

/** 把任意输入规整成可用的策略表；告警随结果返回，由 loadConfig 输出 */
export function sanitizePolicy(policy: PolicyConfig | undefined): { policy: PolicyConfig; warnings: string[] } {
  const warnings: string[] = [];
  const out: PolicyConfig = {};
  if (policy === undefined) return { policy: out, warnings };
  if (!isObject(policy)) return { policy: out, warnings: ["policy 必须是对象，已忽略"] };

  for (const [source, raw] of Object.entries(policy as Record<string, unknown>)) {
    if (!isObject(raw)) {
      warnings.push(`policy.${source} 不是对象，已忽略`);
      continue;
    }
    const patch: SourcePolicyPatch = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!Object.hasOwn(PATCH_FIELDS, key)) {
        warnings.push(`policy.${source}.${key} 是未知字段，已忽略`);
        continue;
      }
      if (key === "allowed") {
        if (typeof value === "boolean") patch.allowed = value;
        else warnings.push(`policy.${source}.allowed 必须是布尔值，已忽略`);
      } else if (key === "accept") {
        if (isAcceptMode(value)) patch.accept = value;
        else warnings.push(`policy.${source}.accept 只能是 off/observe/auto，已回落到默认`);
      } else {
        const admission = sanitizeAdmission(source, value, warnings);
        if (admission) patch.admission = admission;
      }
    }
    out[source] = patch;
  }
  return { policy: out, warnings };
}

export function policyWarnings(policy: PolicyConfig | undefined): string[] {
  return sanitizePolicy(policy).warnings;
}

/** 单来源解析：来源默认值 + 配置覆盖 */
export function resolvePolicy(policy: PolicyConfig | undefined, source: string): SourcePolicy {
  const base = SOURCE_DEFAULTS[source] ?? DEFAULT_SOURCE_POLICY;
  const patch = policy?.[source];
  if (!patch) return base;
  const admission = patch.admission;
  return {
    allowed: patch.allowed ?? base.allowed,
    accept: patch.accept ?? base.accept,
    admission: {
      listed: { ...base.admission.listed, ...admission?.listed },
      unlisted: { ...base.admission.unlisted, ...admission?.unlisted },
    },
  };
}

function cellReason(listed: boolean, mentioned: boolean): string {
  if (!listed && !mentioned) return "无权限：用户不在白名单，且没有点名 pisa。";
  if (!listed) return "无权限：用户不在白名单，该来源不接名单外点名。";
  return "无权限：该来源的名单内用户未获准入。";
}

/** 准入判定：来源是否开放 → 命中格 → 接单模式 */
export function admit(input: PolicyInput, req: { source: string; listed: boolean; mentioned: boolean }): AdmissionVerdict {
  const policy = sanitizePolicy(input.policy).policy;
  const source = resolvePolicy(policy, req.source);
  const cell: AdmissionCellKey = `${req.listed ? "listed" : "unlisted"}:${req.mentioned ? "mentioned" : "plain"}`;
  const cells = req.listed ? source.admission.listed : source.admission.unlisted;
  const open = req.mentioned ? cells.mentioned : cells.plain;
  const verdict = (admitted: boolean, execute: boolean, reason: string): AdmissionVerdict => ({
    admitted,
    execute,
    mode: source.accept,
    cell,
    reason,
  });

  if (!source.allowed) return verdict(false, false, `无权限：来源 ${req.source} 未开放接单（allowed=false）。`);
  if (!open) return verdict(false, false, cellReason(req.listed, req.mentioned));
  if (source.accept === "off") return verdict(false, false, `无权限：来源 ${req.source} 暂停接单（accept=off）。`);
  if (source.accept === "observe") {
    return verdict(true, false, `来源 ${req.source} 处于观察模式（accept=observe），只做准入记录。`);
  }
  return verdict(true, true, "");
}

/** 把判定结果固化成任务凭据 */
export function mandateOf(req: { source: string; listed: boolean; mentioned: boolean }, verdict: AdmissionVerdict): Mandate {
  return { source: req.source, listed: req.listed, mentioned: req.mentioned, cell: verdict.cell, mode: verdict.mode };
}

/**
 * 策略版本：只覆盖影响准入的输入——用户白名单与各来源解析结果。
 * 仓库白名单、路径、worker 配置不影响「谁能从哪派活」，计入会让版本无意义地抖动。
 */
export function policyVersion(input: PolicyInput): string {
  const policy = sanitizePolicy(input.policy).policy;
  const users = [...(input.whitelist?.users ?? [])].sort();
  const sources = [...new Set([...KNOWN_SOURCES, ...Object.keys(policy)])].sort();
  const table = sources.map((s) => [s, resolvePolicy(policy, s)]);
  return `p-${createHash("sha256").update(JSON.stringify({ users, table })).digest("hex").slice(0, 12)}`;
}

function cellLine(label: string, cells: { mentioned: boolean; plain: boolean }): string {
  return `${label}：点名 ${cells.mentioned ? "放行" : "拒绝"} · 未点名 ${cells.plain ? "放行" : "拒绝"}`;
}

/** `/pisa policy` 的回执：当前放行面与版本 */
export function formatPolicy(input: PolicyInput): string {
  const policy = sanitizePolicy(input.policy).policy;
  const users = [...(input.whitelist?.users ?? [])].sort();
  const repos = [...(input.whitelist?.repos ?? [])].sort();
  const sources = [...KNOWN_SOURCES, ...Object.keys(policy).filter((s) => !KNOWN_SOURCES.includes(s)).sort()];
  const lines = [
    `准入策略 ${policyVersion(input)}`,
    `白名单用户：${users.length ? users.join("、") : "（空）"}`,
    `白名单仓库：${repos.length ? repos.join("、") : "（空）"}`,
    "",
    "来源 · 开放状态 · 接单模式",
  ];
  for (const source of sources) {
    const p = resolvePolicy(policy, source);
    lines.push(`${source} · ${p.allowed ? "开放" : "关闭"} · ${p.accept}`);
    lines.push(`  ${cellLine("名单内", p.admission.listed)}`);
    lines.push(`  ${cellLine("名单外", p.admission.unlisted)}`);
  }
  lines.push("", "改 pisa.config.json 的 policy 后重启生效；变更不追溯已建立的任务，恢复暂停任务前按当前策略重校验。");
  return lines.join("\n");
}
