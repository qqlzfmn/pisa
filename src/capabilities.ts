import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DEFAULT_ENV_ALLOW, type CapabilityConfig, type Config } from "./config";

/**
 * 内置拦截规则：由 extensions/guard.ts 固定实现，此处只用于启动日志与审计展示。
 * guard 不读这份列表，改规则必须两边同时改。
 */
export const DEFAULT_BLOCKED: readonly string[] = [
  "git push",
  "git rebase",
  "git reset --hard",
  "git clean -f",
  "git checkout <ref>",
  "git switch <ref>",
  "git worktree remove/prune",
  "git branch -D",
  "git commit --amend",
  "sudo",
  "rm -rf /",
  "chmod/chown /etc",
];

/** 能力声明的来源：全局基线与按仓库覆盖 */
export interface CapabilitySource {
  global?: CapabilityConfig;
  repos: Record<string, CapabilityConfig | undefined>;
}

/** 合并后的能力：数组是两处声明的并集 */
export interface ResolvedCapabilities {
  read: string[];
  write: string[];
  env: string[];
  domains: string[];
  gui: boolean;
  blocked: string[];
}

export interface CapabilityManifest extends ResolvedCapabilities {
  repo: string;
  /** 任务工作目录，恒在 read/write 中 */
  workdir: string;
  builtin: string[];
}

export interface CapabilityViolation {
  tool: string;
  detail: string;
  reason: string;
}

export interface TaskAudit {
  capabilities: CapabilityManifest;
  violations: CapabilityViolation[];
}

/** 一次任务最多保留的违规条数，防止台账被刷屏撑大 */
export const MAX_VIOLATIONS = 100;

export function capabilitySource(cfg: Pick<Config, "capabilities" | "repos">): CapabilitySource {
  const repos: Record<string, CapabilityConfig | undefined> = {};
  for (const repo of cfg.repos) repos[repo.alias] = repo.capabilities;
  return { global: cfg.capabilities, repos };
}

const union = (a: readonly string[] = [], b: readonly string[] = []): string[] => [...new Set([...a, ...b])];

export function resolveCapabilities(source: CapabilitySource | undefined, repo: string): ResolvedCapabilities {
  const global = source?.global ?? {};
  const local = source?.repos[repo] ?? {};
  return {
    read: union(global.read, local.read),
    write: union(global.write, local.write),
    env: union(global.env, local.env),
    domains: union(global.domains, local.domains),
    gui: local.gui ?? global.gui ?? false,
    blocked: union(global.blocked, local.blocked),
  };
}

/**
 * 生成任务清单：相对声明的目录按工作目录解析，工作目录自身恒在列；
 * env 是进程白名单与仓库密钥的并集。
 */
export function capabilityManifest(input: {
  repo: string;
  workdir: string;
  envAllow?: readonly string[];
  caps: ResolvedCapabilities;
}): CapabilityManifest {
  const root = resolve(input.workdir);
  const dirs = (list: readonly string[]) =>
    [...new Set([root, ...list.map((p) => (isAbsolute(p) ? resolve(p) : resolve(root, p)))])];
  return {
    repo: input.repo,
    workdir: root,
    read: dirs(input.caps.read),
    write: dirs(input.caps.write),
    env: union(input.envAllow ?? DEFAULT_ENV_ALLOW, input.caps.env),
    domains: [...input.caps.domains],
    gui: input.caps.gui,
    blocked: [...input.caps.blocked],
    builtin: [...DEFAULT_BLOCKED],
  };
}

const orDash = (list: readonly string[], empty: string) => (list.length > 0 ? list.join(",") : empty);

/** 启动日志用：与 capabilityManifest 同一套合并结果，目录按声明原样展示（相对任务工作目录） */
export function formatCapability(caps: ResolvedCapabilities, envAllow?: readonly string[]): string {
  const env = union(envAllow ?? DEFAULT_ENV_ALLOW, caps.env);
  return [
    `env=${orDash(env, "(空)")}`,
    `read=${["."].concat(caps.read).join(",")}`,
    `write=${["."].concat(caps.write).join(",")}`,
    `domains=${orDash(caps.domains, "—")}`,
    `gui=${caps.gui ? "on" : "off"}`,
    `blocked=${DEFAULT_BLOCKED.concat(caps.blocked).join(", ")}`,
  ].join(" · ");
}

/** `pisa show` 一行摘要：能力规模与拦截次数，最近一条拦截带原因 */
export function formatAudit(audit: TaskAudit): string {
  const m = audit.capabilities;
  const parts = [
    `env=${orDash(m.env, "(空)")}`,
    `可写 ${m.write.length} 个目录`,
    `domains=${orDash(m.domains, "—")}`,
    `gui=${m.gui ? "on" : "off"}`,
    `拦截 ${audit.violations.length} 次`,
  ];
  const last = audit.violations.at(-1);
  if (last) parts.push(`最近 ${last.tool}：${last.reason}`);
  return parts.join(" · ");
}

/** 从 progress jsonl 里收集守卫写入的 blocked 事件；坏行与半行跳过 */
export function readViolations(progressFile: string): CapabilityViolation[] {
  let raw: string;
  try {
    raw = readFileSync(progressFile, "utf8");
  } catch {
    return [];
  }
  const out: CapabilityViolation[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type !== "blocked") continue;
    out.push({
      tool: String(event.tool ?? ""),
      detail: String(event.detail ?? ""),
      reason: String(event.reason ?? ""),
    });
  }
  return out;
}
