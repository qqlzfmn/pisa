import { createHash } from "node:crypto";

/** 一项准入判定支持的处置方式 */
export type AcceptMode = "off" | "observe" | "auto";

/** 入口来源：决定使用哪张准入表 */
export type PolicySource = "im" | "github" | "webhook" | "cron" | "proactive";

export const POLICY_SOURCES: readonly PolicySource[] = ["im", "github", "webhook", "cron", "proactive"];

/** 一个准入单元：名单内外 × 是否 @，对应一种处置方式 */
export interface AdmissionCell {
  listed: boolean;
  mentioned: boolean;
  mode: AcceptMode;
}

export interface SourcePolicy {
  allowed: boolean;
  /** 固定四格，顺序见 ADMISSION_GRID；缺失的格在生效策略里补为 off */
  admission: AdmissionCell[];
}

export interface PolicyConfig {
  /** 不写则按生效策略内容生成哈希版本 */
  version?: string;
  sources?: Partial<Record<PolicySource, Partial<SourcePolicy>>>;
}

export interface EffectivePolicy {
  version: string;
  sources: Record<PolicySource, SourcePolicy>;
}

export interface AdmissionRequest {
  source: PolicySource;
  listed: boolean;
  mentioned: boolean;
}

export interface AdmissionDecision {
  mode: AcceptMode;
  reason: string;
}

const ADMISSION_GRID: ReadonlyArray<readonly [boolean, boolean]> = [
  [true, true],
  [true, false],
  [false, true],
  [false, false],
];

function cellLabel(listed: boolean, mentioned: boolean): string {
  return `${listed ? "名单内" : "名单外"} + ${mentioned ? "@" : "未 @"}`;
}

function isMode(value: unknown): value is AcceptMode {
  return value === "off" || value === "observe" || value === "auto";
}

/** 默认表：名单内直接放行（是否 @ 不影响），名单外一律拒绝；与旧白名单行为一致 */
function defaultAdmission(): AdmissionCell[] {
  return ADMISSION_GRID.map(([listed, mentioned]) => ({
    listed,
    mentioned,
    mode: listed ? "auto" : "off",
  }));
}

function normalizeAdmission(raw: unknown, source: PolicySource): AdmissionCell[] {
  if (!Array.isArray(raw)) throw new Error(`策略配置无效：sources.${source}.admission 必须是数组`);
  const provided = new Map<string, AdmissionCell>();
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new Error(`策略配置无效：sources.${source}.admission 的每一项必须是对象`);
    }
    const cell = item as Partial<AdmissionCell>;
    if (typeof cell.listed !== "boolean" || typeof cell.mentioned !== "boolean" || !isMode(cell.mode)) {
      throw new Error(
        `策略配置无效：sources.${source}.admission 的每一项需要 listed、mentioned 两个布尔值与 off/observe/auto 之一`,
      );
    }
    const key = `${cell.listed}:${cell.mentioned}`;
    if (provided.has(key)) {
      throw new Error(`策略配置无效：sources.${source}.admission 包含重复格（${cellLabel(cell.listed, cell.mentioned)}）`);
    }
    provided.set(key, { listed: cell.listed, mentioned: cell.mentioned, mode: cell.mode });
  }
  return ADMISSION_GRID.map(
    ([listed, mentioned]) => provided.get(`${listed}:${mentioned}`) ?? { listed, mentioned, mode: "off" },
  );
}

function hashPolicy(sources: Record<PolicySource, SourcePolicy>): string {
  const canonical = POLICY_SOURCES.map((source) => {
    const s = sources[source];
    return [source, s.allowed, s.admission.map((c) => [c.listed, c.mentioned, c.mode])];
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** 把可选配置补成完整策略；配置错误直接抛出，避免带病运行 */
export function effectivePolicy(raw?: PolicyConfig): EffectivePolicy {
  for (const key of Object.keys(raw?.sources ?? {})) {
    if (!POLICY_SOURCES.includes(key as PolicySource)) {
      throw new Error(`策略配置无效：未知来源 ${key}`);
    }
  }

  const sources = {} as Record<PolicySource, SourcePolicy>;
  for (const source of POLICY_SOURCES) {
    const conf = raw?.sources?.[source];
    const allowed = conf?.allowed ?? true;
    if (typeof allowed !== "boolean") {
      throw new Error(`策略配置无效：sources.${source}.allowed 必须是布尔值`);
    }
    sources[source] = {
      allowed,
      admission: conf?.admission === undefined ? defaultAdmission() : normalizeAdmission(conf.admission, source),
    };
  }

  if (raw?.version !== undefined && typeof raw.version !== "string") {
    throw new Error("策略配置无效：version 必须是字符串");
  }
  const explicit = raw?.version?.trim();
  return {
    version: explicit ? explicit : `p-${hashPolicy(sources).slice(0, 8)}`,
    sources,
  };
}

/** 判定一条请求是否准入，以及准入后的处置方式 */
export function decide(policy: EffectivePolicy, req: AdmissionRequest): AdmissionDecision {
  const source = policy.sources[req.source];
  if (!source) return { mode: "off", reason: `无权限：未知来源 ${req.source}` };
  if (!source.allowed) return { mode: "off", reason: `无权限：来源 ${req.source} 已禁用` };

  const label = cellLabel(req.listed, req.mentioned);
  const cell = source.admission.find((c) => c.listed === req.listed && c.mentioned === req.mentioned);
  if (!cell || cell.mode === "off") {
    return { mode: "off", reason: `无权限：来源 ${req.source} 的准入单元（${label}）为 off` };
  }
  return { mode: cell.mode, reason: `来源 ${req.source} 的准入单元（${label}）为 ${cell.mode}` };
}

const SOURCE_SET = new Set<string>(POLICY_SOURCES);

/** 通道 → 策略来源；未单列通道（telegram、cli、测试替身）统一算 IM */
export function sourceOf(channel: string): PolicySource {
  return SOURCE_SET.has(channel) ? (channel as PolicySource) : "im";
}
