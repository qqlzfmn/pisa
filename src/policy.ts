import { createHash } from "node:crypto";
import { DEFAULT_SOURCE_POLICY, type AcceptMode, type Config, type SourcePolicy } from "./config";
import type { IncomingMessage } from "./types";

/**
 * 来源准入：谁能派活由「来源 × 是否在白名单 × 是否 @ 机器人」三件事决定。
 * 规则只影响新建任务与 resume；排队与运行中的任务按入队时的结果继续。
 */

/**
 * 走 Router 的已知入口：即使配置里没写，也要在 /pisa policy 里显示生效规则。
 * CLI 不走 Router（本机 shell 即授权边界，与改配置文件同级），所以不在此列。
 */
export const KNOWN_SOURCES: readonly string[] = ["telegram", "web", "webhook", "github", "cron", "proactive"];

/** 名单内外 × 是否 @ 的四格准入结果 */
export interface AdmissionCells {
  listedMentioned: boolean;
  listedPlain: boolean;
  guestMentioned: boolean;
  guestPlain: boolean;
}

/** 一个来源的完整规则；cells 由 requireMention / allowGuests 派生 */
export interface SourceView extends Required<SourcePolicy> {
  name: string;
  cells: AdmissionCells;
}

/** 一次准入裁决；observe 与拒绝都带说明 */
export interface Admission {
  ok: boolean;
  /** ok 时的处理方式；拒绝时为 null */
  mode: AcceptMode | null;
  reason: string;
  listed: boolean;
  mentioned: boolean;
  source: SourceView;
  version: string;
}

/** observe 模式的留痕：任务没建，但能查到谁在什么时候试着派活 */
export interface AdmissionRecord {
  id: string;
  source: string;
  requester: string;
  actor: string;
  mentioned: boolean;
  listed: boolean;
  mode: AcceptMode;
  reason: string;
  policyVersion: string;
  createdAt: number;
}

/** 单条消息的 @ 信号：入口显式给出时以它为准，否则私聊算已 @ */
export function isMentioned(msg: Pick<IncomingMessage, "channel" | "mentioned" | "isDirect">): boolean {
  if (msg.mentioned !== undefined) return msg.mentioned;
  if (msg.isDirect === true) return true;
  // 程序化入口没有 @ 语义：进来的消息本身就是直达
  return MENTIONLESS_CHANNELS.has(msg.channel);
}

const MENTIONLESS_CHANNELS = new Set(["web", "webhook", "github", "cron", "proactive"]);

export function admissionCells(policy: Required<SourcePolicy>): AdmissionCells {
  return {
    listedMentioned: true,
    listedPlain: !policy.requireMention,
    guestMentioned: policy.allowGuests,
    guestPlain: false,
  };
}

/** 解析某个来源的生效规则：配置缺省时回落到与引入策略前一致的默认值 */
export function sourceView(cfg: Config, name: string): SourceView {
  const patch = cfg.policy?.sources?.[name] ?? {};
  const resolved: Required<SourcePolicy> = {
    allowed: patch.allowed ?? DEFAULT_SOURCE_POLICY.allowed,
    requireMention: patch.requireMention ?? DEFAULT_SOURCE_POLICY.requireMention,
    allowGuests: patch.allowGuests ?? DEFAULT_SOURCE_POLICY.allowGuests,
    accept: patch.accept ?? DEFAULT_SOURCE_POLICY.accept,
  };
  return { name, ...resolved, cells: admissionCells(resolved) };
}

/** 规则指纹：白名单或任一来源规则变了就变，任务事后可对上是哪套规则 */
export function policyFingerprint(cfg: Config): string {
  const names = Object.keys(cfg.policy?.sources ?? {}).sort();
  const sources = names.map((name) => {
    const v = sourceView(cfg, name);
    return [name, v.allowed, v.requireMention, v.allowGuests, v.accept];
  });
  const material = JSON.stringify({
    users: [...cfg.whitelist.users].sort(),
    repos: [...cfg.whitelist.repos].sort(),
    sources,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 8);
}

/** 任务记录与 resume 比对用的版本：显式 version 优先，否则用指纹 */
export function policyVersion(cfg: Config): string {
  return cfg.policy?.version?.trim() || policyFingerprint(cfg);
}

/**
 * 准入裁决。顺序：来源总闸 → 四格 → accept 模式。
 * 拒绝理由统一以「无权限：」开头，与引入策略前的提示保持同一语感。
 */
export function admit(cfg: Config, input: { source: string; requester: string; mentioned: boolean }): Admission {
  const source = sourceView(cfg, input.source);
  const listed = cfg.whitelist.users.includes(input.requester);
  const base = { listed, mentioned: input.mentioned, source, version: policyVersion(cfg) };

  if (!source.allowed) {
    return { ...base, ok: false, mode: null, reason: `无权限：来源 ${source.name} 的准入已关闭。` };
  }
  if (listed) {
    if (source.requireMention && !input.mentioned) {
      return { ...base, ok: false, mode: null, reason: `无权限：来源 ${source.name} 要求 @ 机器人后才能派活。` };
    }
  } else if (!(input.mentioned && source.allowGuests)) {
    return { ...base, ok: false, mode: null, reason: "无权限：该用户不在白名单。" };
  }
  if (source.accept === "off") {
    return { ...base, ok: false, mode: null, reason: `无权限：来源 ${source.name} 的 accept 为 off，不接任务。` };
  }
  const reason = listed ? "白名单用户" : "名单外用户被 @ 放行";
  return { ...base, ok: true, mode: source.accept, reason };
}

function cellText(allowed: boolean): string {
  return allowed ? "允许" : "拒绝";
}

function sourceLines(view: SourceView): string {
  const gate = view.allowed ? "开" : "关";
  return [
    `${view.name} · 总闸${gate} · ${view.accept}`,
    `  名单内：@ ${cellText(view.cells.listedMentioned)} · 不 @ ${cellText(view.cells.listedPlain)}`,
    `  名单外：@ ${cellText(view.cells.guestMentioned)} · 不 @ ${cellText(view.cells.guestPlain)}`,
  ].join("\n");
}

/** `/pisa policy` 的正文：规则、四格、版本与最近的 observe 记录 */
export function formatPolicy(cfg: Config, recent: readonly AdmissionRecord[] = []): string {
  const extra = Object.keys(cfg.policy?.sources ?? {}).filter((name) => !KNOWN_SOURCES.includes(name));
  const names = [...KNOWN_SOURCES, ...extra.sort()];
  const lines = [
    `pisa · 来源准入 · 版本 ${policyVersion(cfg)}（指纹 ${policyFingerprint(cfg)}）`,
    `白名单：用户 ${cfg.whitelist.users.length} 个 · 仓库 ${cfg.whitelist.repos.length} 个`,
    "规则只影响新任务与 resume；observe 只记录不派活。",
    "",
    ...names.map((name) => sourceLines(sourceView(cfg, name))).flatMap((block) => [block, ""]),
  ];
  if (recent.length > 0) {
    lines.push(`最近 observe（${recent.length}）：`);
    for (const r of recent) {
      const at = new Date(r.createdAt).toISOString().slice(5, 16).replace("T", " ");
      lines.push(`- ${r.source} · ${r.requester} · ${r.mentioned ? "@" : "不 @"} · ${at}`);
    }
  } else {
    lines.push("最近 observe：无");
  }
  lines.push("改规则：pisa.config.json 的 policy 段（docs/operations.md）。");
  return lines.join("\n");
}
