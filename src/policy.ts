import { createHash } from "node:crypto";

/** 一格的处理方式：off 拒绝、observe 只留痕、auto 接单 */
export type AcceptMode = "off" | "observe" | "auto";

/** 准入格：名单内外 × 是否 @ 了本服务 */
export type AdmissionCell = "listedMention" | "listedPlain" | "unlistedMention" | "unlistedPlain";

/** 配置写法：一个模式同时给两格，或按是否 @ 分别给 */
export type CellsPatch = AcceptMode | { mention?: AcceptMode; plain?: AcceptMode };

export interface SourcePolicyPatch {
  allowed?: boolean;
  listed?: CellsPatch;
  unlisted?: CellsPatch;
}

/** 配置里的 policy 段：每个来源一份准入策略 */
export interface PolicyConfig {
  sources?: Record<string, SourcePolicyPatch>;
}

export interface SourcePolicy {
  allowed: boolean;
  cells: Record<AdmissionCell, AcceptMode>;
}

export interface ResolvedPolicy {
  /** 策略版本：来源策略或名单任一变化都会换版本 */
  version: string;
  /** 排序后的名单：决定「名单内 / 名单外」这一维 */
  users: readonly string[];
  sources: Record<string, SourcePolicy>;
}

export interface AdmissionInput {
  /** 来源：与任务的 channel 同值（telegram / github / webhook / web / cron / cli / proactive） */
  channel: string;
  userId: string;
  /** 真实发起人；缺省与 userId 相同 */
  actor?: string;
  /** 消息是否 @ 了本服务；只有 IM 入口能给出 */
  mentioned?: boolean;
}

export interface PolicyDecision {
  version: string;
  source: string;
  actor: string;
  listed: boolean;
  mentioned: boolean;
  cell: AdmissionCell;
  mode: AcceptMode;
  /** 一句话说明判定依据，直接作为回复与留痕内容 */
  reason: string;
}

/** 任务的准入凭据：它按哪条策略、哪一格被接下 */
export interface Mandate {
  source: string;
  actor: string;
  listed: boolean;
  mentioned: boolean;
  cell: AdmissionCell;
}

const OPEN: Readonly<Record<AdmissionCell, AcceptMode>> = {
  listedMention: "auto",
  listedPlain: "auto",
  unlistedMention: "auto",
  unlistedPlain: "auto",
};

const MEMBER_ONLY: Readonly<Record<AdmissionCell, AcceptMode>> = {
  listedMention: "auto",
  listedPlain: "auto",
  unlistedMention: "off",
  unlistedPlain: "off",
};

/**
 * 默认全放开的来源：本地进程与已由配置身份投递的入口。
 * cli 的调用者能直接读写本机状态，OS 账号就是身份；github 沿用「评论作者不参与鉴权」的既有模型。
 */
const OPEN_BY_DEFAULT: Readonly<Record<string, true>> = { cli: true, github: true };

/** 已知来源：版本号也覆盖它们，默认值变化同样体现在版本里 */
const KNOWN_SOURCES: readonly string[] = ["telegram", "cli", "web", "webhook", "github", "cron", "proactive"];

function defaultsFor(source: string): SourcePolicy {
  return { allowed: true, cells: { ...(OPEN_BY_DEFAULT[source] ? OPEN : MEMBER_ONLY) } };
}

/** 把 `listed` / `unlisted` 的两种写法展开成两格 */
function cellsOf(patch: CellsPatch | undefined, listed: boolean): Partial<Record<AdmissionCell, AcceptMode>> {
  if (!patch) return {};
  const mention: AdmissionCell = listed ? "listedMention" : "unlistedMention";
  const plain: AdmissionCell = listed ? "listedPlain" : "unlistedPlain";
  if (typeof patch === "string") return { [mention]: patch, [plain]: patch };
  const out: Partial<Record<AdmissionCell, AcceptMode>> = {};
  if (patch.mention) out[mention] = patch.mention;
  if (patch.plain) out[plain] = patch.plain;
  return out;
}

/**
 * 解析出完整策略与版本。
 * 版本覆盖「解析后的每个来源策略 + 排序后的名单」，所以改名单、改任何一格都会换版本；
 * 判定只用解析结果，不再看原始配置。
 */
export function resolvePolicy(patch: PolicyConfig | undefined, users: readonly string[]): ResolvedPolicy {
  const sorted = [...new Set(users)].sort();
  const names = [...new Set([...KNOWN_SOURCES, ...Object.keys(patch?.sources ?? {})])].sort();
  const sources: Record<string, SourcePolicy> = {};
  for (const name of names) {
    const p = patch?.sources?.[name] ?? {};
    const base = defaultsFor(name);
    sources[name] = {
      allowed: p.allowed ?? base.allowed,
      cells: { ...base.cells, ...cellsOf(p.listed, true), ...cellsOf(p.unlisted, false) },
    };
  }
  const canonical = JSON.stringify({ users: sorted, sources });
  const version = `v${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
  return { version, users: sorted, sources };
}

/** 准入判定：来源是否开启、这条消息落在哪一格、该格怎么处理 */
export function decideAdmission(policy: ResolvedPolicy, input: AdmissionInput): PolicyDecision {
  const source = input.channel;
  const p = policy.sources[source] ?? defaultsFor(source);
  const listed = policy.users.includes(input.userId);
  const mentioned = input.mentioned === true;
  const cell: AdmissionCell = listed
    ? mentioned
      ? "listedMention"
      : "listedPlain"
    : mentioned
      ? "unlistedMention"
      : "unlistedPlain";
  const decision: PolicyDecision = {
    version: policy.version,
    source,
    actor: input.actor ?? input.userId,
    listed,
    mentioned,
    cell,
    mode: p.allowed ? p.cells[cell] : "off",
    reason: "",
  };
  const who = `${source} · ${listed ? "名单内" : "名单外"}用户${mentioned ? "、@ 了本服务" : ""}`;
  decision.reason = p.allowed ? `${who} · ${cell} = ${decision.mode}（${policy.version}）` : `${who} · 来源已关闭（${policy.version}）`;
  return decision;
}

/** 任务的准入凭据压成一行，用于拒绝回复与排障 */
export function describeMandate(m: Mandate): string {
  return `${m.source} · ${m.listed ? "名单内" : "名单外"}用户${m.mentioned ? "、@ 了本服务" : ""} · ${m.cell}`;
}

/** `/pisa policy` 的正文：版本、每来源的允许与四格、观察记录数 */
export function formatPolicy(policy: ResolvedPolicy, observed: number): string {
  const lines = [
    `策略版本 ${policy.version}（来源策略或名单变化都会换版本；改配置后重启生效）`,
    `名单 ${policy.users.length} 人｜写法：名单内 @/未@ · 名单外 @/未@`,
    "",
  ];
  const nameWidth = Math.max(...Object.keys(policy.sources).map((s) => s.length), 6);
  for (const [name, p] of Object.entries(policy.sources)) {
    const c = p.cells;
    lines.push(
      `${name.padEnd(nameWidth)} · ${p.allowed ? "允许" : "关闭"} · ` +
        `名单内 ${c.listedMention}/${c.listedPlain} · 名单外 ${c.unlistedMention}/${c.unlistedPlain}`,
    );
  }
  lines.push(
    "",
    "模式：auto 接单 · observe 只记录不建任务 · off 拒绝",
    `最近 observe 记录 ${observed} 条（明细见 pisa.db 的 admissions 表）`,
  );
  return lines.join("\n");
}
