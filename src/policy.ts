import { createHash } from "node:crypto";
import type { AcceptMode, AdmissionCell, Config } from "./config";

/** 准入单元：名单内外 × 是否点名机器人 */
export const ADMISSION_CELLS: readonly AdmissionCell[] = [
  "member.mentioned",
  "member.unmentioned",
  "stranger.mentioned",
  "stranger.unmentioned",
];

/** 默认单元：名单内照旧放行，名单外一律拒绝（与引入策略前的行为一致） */
export const DEFAULT_CELLS: Readonly<Record<AdmissionCell, AcceptMode>> = {
  "member.mentioned": "auto",
  "member.unmentioned": "auto",
  "stranger.mentioned": "off",
  "stranger.unmentioned": "off",
};

/** 来源策略解析后的样子：缺省值已补齐，判定只看它 */
export interface ResolvedSource {
  source: string;
  allowed: string[];
  /** 名单是否直接沿用 whitelist.users */
  inherited: boolean;
  /** 来源级闸门：off / observe 覆盖所有单元，auto 交给单元判定 */
  accept: AcceptMode;
  cells: Record<AdmissionCell, AcceptMode>;
}

export interface AdmissionInput {
  source: string;
  principal: string;
  mentioned: boolean;
}

/**
 * 一次准入判定，也是任务上的授权记录。
 * 建单时落库，之后策略怎么改都不回写；恢复时按当前策略重新判定，与这里对照。
 */
export interface Mandate {
  source: string;
  principal: string;
  mentioned: boolean;
  member: boolean;
  cell: AdmissionCell;
  mode: AcceptMode;
  /** 给人看的判定说明，拒绝时直接回给请求方 */
  reason: string;
  policyVersion: string;
  decidedAt: number;
}

/** 单个来源生效的策略：显式配置覆盖默认，allowed 缺省沿用全局名单 */
export function resolveSource(cfg: Config, source: string): ResolvedSource {
  const raw = cfg.policy?.sources?.[source];
  return {
    source,
    allowed: raw?.allowed ?? cfg.whitelist.users,
    inherited: raw?.allowed === undefined,
    accept: raw?.accept ?? "auto",
    cells: { ...DEFAULT_CELLS, ...(raw?.cells ?? {}) },
  };
}

export function admissionCell(member: boolean, mentioned: boolean): AdmissionCell {
  return `${member ? "member" : "stranger"}.${mentioned ? "mentioned" : "unmentioned"}`;
}

/** 判定一次准入：来源 → 名单内外 → 是否点名 → 单元 → 方式 */
export function decide(cfg: Config, input: AdmissionInput, at: number): Mandate {
  const policy = resolveSource(cfg, input.source);
  const member = policy.allowed.includes(input.principal);
  const cell = admissionCell(member, input.mentioned);
  const mode = policy.accept === "auto" ? policy.cells[cell] : policy.accept;
  return {
    ...input,
    member,
    cell,
    mode,
    reason: explain(input, member, cell, mode),
    policyVersion: policyVersion(cfg),
    decidedAt: at,
  };
}

function explain(input: AdmissionInput, member: boolean, cell: AdmissionCell, mode: AcceptMode): string {
  if (mode === "observe") {
    return `已记录 · 来源 ${input.source} 对 ${cell} 为 observe，只记录不派活。`;
  }
  if (mode === "off") {
    return member
      ? `无权限：来源 ${input.source} 关闭了 ${cell} 的准入。`
      : `无权限：${input.principal} 不在来源 ${input.source} 的准入名单（${cell}）。`;
  }
  return `放行 · ${input.source} · ${cell}。`;
}

/**
 * 策略版本：名单与各来源的生效规则一起算，任一准入相关配置变化都会换版本。
 * 与来源无关的配置（触发词、并发）不参与，避免版本无意义地抖动。
 */
export function policyVersion(cfg: Config): string {
  const sources = Object.keys(cfg.policy?.sources ?? {})
    .sort()
    .map((name) => {
      const p = resolveSource(cfg, name);
      return [name, [...p.allowed].sort(), p.accept, ADMISSION_CELLS.map((c) => p.cells[c])];
    });
  const payload = JSON.stringify({ users: [...cfg.whitelist.users].sort(), sources });
  return createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

/** `/pisa policy`：当前生效规则与版本，配置项名与 JSON 里的一致 */
export function formatPolicy(cfg: Config): string {
  const lines = [
    `准入策略 · 版本 ${policyVersion(cfg)}`,
    "改动只影响新任务；已建任务保留建单时的授权记录，恢复前按当前策略重校验。",
    "",
    "默认（未单独配置的来源）",
    // 空来源名取不到显式配置，正好是「未配置时的生效规则」
    ...formatSource(resolveSource(cfg, "")),
  ];
  for (const source of Object.keys(cfg.policy?.sources ?? {}).sort()) {
    lines.push("", source, ...formatSource(resolveSource(cfg, source)));
  }
  return lines.join("\n");
}

function formatSource(p: ResolvedSource): string[] {
  const who = p.inherited ? "whitelist.users" : p.source;
  const cells = ADMISSION_CELLS.map((c) => `${c}=${p.cells[c]}`).join(" · ");
  return [
    `  名单：${who}（${p.allowed.join(", ") || "空"}）`,
    `  accept：${p.accept}${p.accept === "auto" ? "（按单元判定）" : "（覆盖所有单元）"}`,
    `  单元：${cells}`,
  ];
}
