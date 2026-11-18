import { createHash } from "node:crypto";
import type { AcceptMode, AdmissionCell, CellKind, CellRole, Config, PolicyConfig, SourcePolicy } from "./config";
import type { IncomingMessage } from "./types";

export type { AcceptMode, AdmissionCell, CellKind, CellRole, PolicyConfig, SourcePolicy };

/** 已知入口：`/pisa policy` 列出全部；未配置的来源按默认规则判定 */
export const KNOWN_SOURCES: readonly string[] = [
  "telegram",
  "cli",
  "web",
  "webhook",
  "cron",
  "github",
  "github-actions",
  "feishu",
  "wecom",
  "file-watch",
  "proactive",
];

/**
 * 这些入口的 userId 是投递身份，真实发起人在 actor：
 * 来源配置了策略时按 actor 判定（名单也取该入口自己的白名单）。
 */
const ACTOR_SOURCES: Record<string, true> = { feishu: true, wecom: true, github: true };

const DEFAULT_CELLS: Readonly<Record<CellRole, Record<CellKind, AdmissionCell>>> = {
  listed: { mention: "allow", plain: "allow" },
  unlisted: { mention: "deny", plain: "deny" },
};

/** 归一后的来源规则：判定与展示只读这一份 */
export interface SourceRules {
  /** 判定用的主体字段：user 用 userId，actor 用平台真实发起人 */
  subject: "user" | "actor";
  allowed: string[];
  cells: Record<CellRole, Record<CellKind, AdmissionCell>>;
  accept: AcceptMode;
}

export interface PolicySnapshot {
  /** 策略表内容哈希（12 位）：规则变化才变 */
  version: string;
  sources: Record<string, SourceRules>;
  /** 未列出的运行时来源（插件通道）用的缺省规则 */
  fallback: SourceRules;
}

export interface AdmissionDecision {
  version: string;
  source: string;
  subject: string;
  listed: boolean;
  mentioned: boolean;
  /** 命中的格，如 listed.mention */
  cell: string;
  accept: AcceptMode;
  allowed: boolean;
  reason: string | null;
}

/** observe 模式下被记录、未接单的请求 */
export interface AdmissionRecord {
  eventId: string;
  source: string;
  subject: string;
  cell: string;
  accept: AcceptMode;
  policyVersion: string;
  prompt: string;
  at: number;
}

/** 飞书/企业微信用自己的 users 白名单，其余入口用全局白名单 */
function scopedUsers(cfg: Config, source: string): string[] | undefined {
  if (source === "feishu") return cfg.triggers?.feishu?.users;
  if (source === "wecom") return cfg.triggers?.wecom?.users;
  return undefined;
}

function rulesFor(cfg: Config, source: string): SourceRules {
  const entry = cfg.policy?.sources?.[source];
  const scoped = scopedUsers(cfg, source);
  const allowed = entry
    ? (entry.allowed ?? (scoped && scoped.length > 0 ? scoped : cfg.whitelist.users))
    : cfg.whitelist.users;
  return {
    // 没配置策略时不改旧行为：仍按 userId 判定
    subject: entry && ACTOR_SOURCES[source] ? "actor" : "user",
    allowed: [...allowed],
    cells: {
      listed: { ...DEFAULT_CELLS.listed, ...entry?.cells?.listed },
      unlisted: { ...DEFAULT_CELLS.unlisted, ...entry?.cells?.unlisted },
    },
    accept: entry?.accept ?? "auto",
  };
}

/** 配置 → 策略快照；版本由内容哈希得到，不另存版本号 */
export function policySnapshot(cfg: Config): PolicySnapshot {
  const names = [...new Set([...KNOWN_SOURCES, ...Object.keys(cfg.policy?.sources ?? {})])].sort();
  const sources: Record<string, SourceRules> = {};
  for (const name of names) sources[name] = rulesFor(cfg, name);
  const fallback: SourceRules = {
    subject: "user",
    allowed: [...cfg.whitelist.users],
    cells: {
      listed: { ...DEFAULT_CELLS.listed },
      unlisted: { ...DEFAULT_CELLS.unlisted },
    },
    accept: "auto",
  };
  const version = createHash("sha256")
    .update(JSON.stringify({ sources, fallback }))
    .digest("hex")
    .slice(0, 12);
  return { version, sources, fallback };
}

/** 判定主体：按来源规则决定用 userId 还是平台真实发起人 */
export function admissionSubject(policy: PolicySnapshot, msg: IncomingMessage): string {
  const rules = policy.sources[msg.channel] ?? policy.fallback;
  return rules.subject === "actor" ? (msg.actor ?? msg.userId) : msg.userId;
}

export function decide(
  policy: PolicySnapshot,
  input: { source: string; subject: string; mentioned: boolean },
): AdmissionDecision {
  const rules = policy.sources[input.source] ?? policy.fallback;
  const listed = rules.allowed.includes(input.subject);
  const role: CellRole = listed ? "listed" : "unlisted";
  const kind: CellKind = input.mentioned ? "mention" : "plain";
  const cell = `${role}.${kind}`;
  const base = {
    version: policy.version,
    source: input.source,
    subject: input.subject,
    listed,
    mentioned: input.mentioned,
    cell,
    accept: rules.accept,
  };
  if (rules.cells[role][kind] === "deny") {
    const reason = listed
      ? `无权限：${input.source} 准入规则 ${cell}=deny。`
      : `无权限：${input.subject} 不在 ${input.source} 准入名单。`;
    return { ...base, allowed: false, reason };
  }
  if (rules.accept === "off") return { ...base, allowed: false, reason: `${input.source} 入口当前不接单（accept=off）。` };
  return { ...base, allowed: true, reason: null };
}

export interface RecheckResult {
  ok: boolean;
  version: string;
  reason: string | null;
  /** 当前版本与接单时版本是否不同 */
  changed: boolean;
}

/**
 * 恢复前的重校验：按任务接单时的认定事实（来源、主体、是否 @）重放当前策略。
 * 只接受 auto：observe 的任务本来没接单，策略降为 observe/off 时不恢复。
 */
export function recheck(
  policy: PolicySnapshot,
  input: { source: string; subject: string; mentioned: boolean; previousVersion: string | null },
): RecheckResult {
  const decision = decide(policy, input);
  const changed = input.previousVersion !== null && input.previousVersion !== decision.version;
  const since = changed ? `（接单时版本 ${input.previousVersion}）` : "";
  if (!decision.allowed) {
    return { ok: false, version: decision.version, changed, reason: `策略 ${decision.version} 拒绝恢复：${decision.reason}${since}` };
  }
  if (decision.accept !== "auto") {
    return {
      ok: false,
      version: decision.version,
      changed,
      reason: `策略 ${decision.version} 把 ${input.source} 降为 ${decision.accept}，不恢复执行${since}。`,
    };
  }
  return { ok: true, version: decision.version, changed, reason: null };
}

const CELL_LABEL: Record<CellKind, string> = { mention: "@", plain: "未@" };

/** `/pisa policy` 正文：规则与版本在前，最近的 observe 记录在后 */
export function formatPolicy(policy: PolicySnapshot, observations: readonly AdmissionRecord[] = []): string {
  const lines = [`准入策略 · version ${policy.version}`];
  for (const [name, r] of Object.entries(policy.sources)) {
    const listed = `${CELL_LABEL.mention}=${r.cells.listed.mention} ${CELL_LABEL.plain}=${r.cells.listed.plain}`;
    const unlisted = `${CELL_LABEL.mention}=${r.cells.unlisted.mention} ${CELL_LABEL.plain}=${r.cells.unlisted.plain}`;
    lines.push(`${name} · accept=${r.accept} · 名单 ${r.allowed.length} · listed ${listed} · unlisted ${unlisted}`);
  }
  if (observations.length > 0) {
    lines.push("", `observe 记录（最近 ${observations.length} 条）`);
    for (const r of observations) {
      const d = new Date(r.at);
      const at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      lines.push(`${at} · ${r.source} · ${r.subject} · ${r.cell} · 策略 ${r.policyVersion} · ${r.prompt}`);
    }
  }
  return lines.join("\n");
}
