import { createHash } from "node:crypto";
import type { AcceptMode, AdmissionCell, AdmissionTableConfig, Config, PolicySourceConfig } from "./config";
import type { TaskMandate } from "./types";

/**
 * 来源准入：谁能派活由「来源 + 名单 + 是否 @」决定，策略本身带版本。
 * 版本只记录不追溯：已创建的任务保留当时的 mandate；恢复执行前按当前策略重校验。
 */

/** 已知入口；配置文件里写了别的来源名会追加进表，不会被忽略 */
export const POLICY_SOURCES = [
  "cli",
  "telegram",
  "web",
  "webhook",
  "github",
  "github-actions",
  "feishu",
  "wecom",
  "file-watch",
  "cron",
  "proactive",
] as const;

export interface AdmissionTable {
  listed: { mentioned: AdmissionCell; unmentioned: AdmissionCell };
  unlisted: { mentioned: AdmissionCell; unmentioned: AdmissionCell };
}

export interface SourcePolicy {
  allowed: string[];
  admit: AdmissionTable;
  accept: AcceptMode;
}

export interface Policy {
  version: string;
  sources: Record<string, SourcePolicy>;
}

export interface Admission {
  mandate: TaskMandate;
  /** 最终是否放行：off 一律拒绝，observe 只记录不拦，auto 按准入表 */
  admitted: boolean;
  policyVersion: string;
}

/**
 * 默认准入表。私聊、带触发词、系统投递（isDirect）一律视为已 @，
 * 所以收紧「名单内未 @」只影响群里没打招呼的闲聊，不改变现有入口。
 */
const DEFAULT_ADMIT: AdmissionTable = {
  listed: { mentioned: "allow", unmentioned: "deny" },
  unlisted: { mentioned: "deny", unmentioned: "deny" },
};

const MODES: readonly AcceptMode[] = ["off", "observe", "auto"];

const cell = (value: unknown, fallback: AdmissionCell): AdmissionCell =>
  value === "allow" || value === "deny" ? value : fallback;

function admitTable(patch?: AdmissionTableConfig): AdmissionTable {
  return {
    listed: {
      mentioned: cell(patch?.listed?.mentioned, DEFAULT_ADMIT.listed.mentioned),
      unmentioned: cell(patch?.listed?.unmentioned, DEFAULT_ADMIT.listed.unmentioned),
    },
    unlisted: {
      mentioned: cell(patch?.unlisted?.mentioned, DEFAULT_ADMIT.unlisted.mentioned),
      unmentioned: cell(patch?.unlisted?.unmentioned, DEFAULT_ADMIT.unlisted.unmentioned),
    },
  };
}

/** 固定的键序，保证同一份策略在任意写法下算出同一个版本 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function resolvePolicy(cfg: Config): Policy {
  const names = [...new Set<string>([...POLICY_SOURCES, ...Object.keys(cfg.policy?.sources ?? {})])].sort();
  const sources: Record<string, SourcePolicy> = {};
  for (const name of names) {
    const own: PolicySourceConfig = cfg.policy?.sources?.[name] ?? {};
    sources[name] = {
      allowed: [...new Set(own.allowed ?? [])].sort(),
      admit: admitTable(own.admit),
      accept: MODES.includes(own.accept as AcceptMode) ? (own.accept as AcceptMode) : "auto",
    };
  }
  const version = createHash("sha256")
    .update(canonical({ whitelist: cfg.whitelist, sources }))
    .digest("hex")
    .slice(0, 8);
  return { version, sources };
}

export interface AdmissionInput {
  source: string;
  /** 真实发起人：入口侧 actor，缺省是投递身份 */
  actor: string;
  mentioned: boolean;
}

/** 名单留空 = 不额外限制（沿用白名单留空即不限制的惯例）；非空时名单外一律按准入表处理 */
export function decide(policy: Policy, input: AdmissionInput): Admission {
  const source = policy.sources[input.source] ?? { allowed: [], admit: DEFAULT_ADMIT, accept: "auto" as AcceptMode };
  const listed = source.allowed.length === 0 || source.allowed.includes(input.actor);
  const decision = source.admit[listed ? "listed" : "unlisted"][input.mentioned ? "mentioned" : "unmentioned"];
  const reason =
    source.accept !== "off" && decision === "allow"
      ? null
      : source.accept === "off"
        ? `来源 ${input.source} 已关闭（accept=off）`
        : listed
          ? `来源 ${input.source} 不接受未 @ 机器人的消息`
          : `${input.actor} 不在来源 ${input.source} 的准入名单`;
  return {
    mandate: {
      source: input.source,
      actor: input.actor,
      listed,
      mentioned: input.mentioned,
      decision,
      mode: source.accept,
      reason,
    },
    admitted: source.accept === "auto" ? decision === "allow" : source.accept === "observe",
    policyVersion: policy.version,
  };
}

const LABEL: Record<AdmissionCell, string> = { allow: "允许", deny: "拒绝" };

/** `/pisa policy` 的正文：规则与版本一屏看完，未结束任务按版本计数 */
export function formatPolicy(policy: Policy, activeByVersion: Record<string, number>): string {
  const lines = [`准入策略 · 版本 ${policy.version}`];
  for (const [name, s] of Object.entries(policy.sources)) {
    const allowed = s.allowed.length === 0 ? "不限" : s.allowed.join(",");
    const { listed, unlisted } = s.admit;
    lines.push(
      `${name}  ${s.accept}  名单=${allowed}  ` +
        `内:@${LABEL[listed.mentioned]}/未@${LABEL[listed.unmentioned]}  外:@${LABEL[unlisted.mentioned]}/未@${LABEL[unlisted.unmentioned]}`,
    );
  }
  const counts = Object.entries(activeByVersion)
    .sort((a, b) => b[1] - a[1])
    .map(([version, n]) => `${version === "-" ? "未记录" : version} ${n}`)
    .join(" · ");
  lines.push("", counts ? `未结束任务按版本：${counts}` : "当前没有未结束的任务。");
  lines.push("规则改在 pisa.config.json 的 policy.sources.<来源>，重启生效；恢复任务前按当时策略重校验。");
  return lines.join("\n");
}
