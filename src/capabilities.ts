import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_ENV_ALLOW, type Config, type RepoConfig } from "./config";
import type { Task } from "./types";

export interface CapabilityConfig {
  read?: string[];
  write?: string[];
  env?: string[];
  domains?: string[];
  gui?: boolean;
  blocked?: string[];
}

export interface Capabilities {
  readDirs: string[];
  writeDirs: string[];
  env: string[];
  domains: string[];
  gui: boolean;
  blocked: string[];
}

export interface CapabilityManifest {
  readDirs: string[];
  writeDirs: string[];
  domains: string[];
  gui: boolean;
  blocked: string[];
}

export interface BlockedCall {
  tool: string;
  detail: string;
  reason: string;
}

export interface AuditEntry extends BlockedCall {
  at: number;
}

export type WorkerConfig = Config["worker"];

function list(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function expand(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function resolveDir(value: string, base: string): string {
  const expanded = expand(value);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/** 把 URL、host:port 或裸主机名归一成小写主机名。 */
export function hostOf(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * 叠加全局、仓库、任务三层能力。目录相对仓库根解析；未声明的项保持关闭。
 */
export function resolveCapabilities(
  worker: WorkerConfig,
  repo?: RepoConfig,
  task?: CapabilityConfig,
): Capabilities {
  const base = repo?.path ? resolve(repo.path) : process.cwd();
  const layers = [worker.capabilities, repo?.capabilities, task];
  const readDirs: string[] = [];
  const writeDirs: string[] = [];
  const extraEnv: string[] = [];
  const domains: string[] = [];
  const blocked: string[] = [];
  let gui = false;

  for (const layer of layers) {
    if (!layer) continue;
    for (const value of list(layer.read)) readDirs.push(resolveDir(value, base));
    for (const value of list(layer.write)) writeDirs.push(resolveDir(value, base));
    extraEnv.push(...list(layer.env));
    for (const value of list(layer.domains)) {
      const host = hostOf(value);
      if (host) domains.push(host);
    }
    blocked.push(...list(layer.blocked));
    if (layer.gui === true) gui = true;
  }

  return {
    readDirs: unique(readDirs),
    writeDirs: unique(writeDirs),
    env: unique([...(worker.envAllow ?? DEFAULT_ENV_ALLOW), ...extraEnv]),
    domains: unique(domains),
    gui,
    blocked: unique(blocked),
  };
}

/** 任务记录里的能力快照优先；旧任务没有快照时按当前配置解析。 */
export function capabilitiesForTask(
  task: Pick<Task, "repo" | "capabilities">,
  worker: WorkerConfig,
  repos: readonly RepoConfig[],
): Capabilities {
  if (task.capabilities) return task.capabilities;
  return resolveCapabilities(worker, repos.find((repo) => repo.alias === task.repo));
}

/** 传给 guard 的清单：在声明目录之外始终保留 worktree 与系统临时目录。 */
export function capabilityManifest(caps: Capabilities, workdir: string): CapabilityManifest {
  const readDirs = unique([resolve(workdir), resolve(tmpdir()), "/tmp", ...caps.readDirs]);
  const writeDirs = unique([resolve(workdir), resolve(tmpdir()), "/tmp", ...caps.writeDirs]);
  return { readDirs, writeDirs, domains: caps.domains, gui: caps.gui, blocked: caps.blocked };
}

function joined(values: readonly string[]): string {
  return values.length ? values.join("、") : "无";
}

/** 人类可读的一行摘要，用于任务详情与启动日志。 */
export function capabilitySummary(caps: Capabilities): string {
  return `读 ${joined(caps.readDirs)} · 写 ${joined(caps.writeDirs)} · 域名 ${joined(caps.domains)} · GUI ${caps.gui ? "允许" : "禁止"}`;
}

/** prompt 与日志用的能力事实清单；与 guard 实际使用的清单保持一致。 */
export function capabilityText(caps: Capabilities, workdir?: string): string {
  const dirs = workdir ? capabilityManifest(caps, workdir) : caps;
  return [
    `- 可读目录：${joined(dirs.readDirs)}`,
    `- 可写目录：${joined(dirs.writeDirs)}`,
    `- 可用环境变量：${joined(caps.env)}`,
    `- 可访问域名：${caps.domains.length ? caps.domains.join("、") : "无（网络命令一律拒绝）"}`,
    `- 图形界面：${caps.gui ? "允许" : "禁止"}`,
    `- 额外拒绝命令：${joined(caps.blocked)}`,
  ].join("\n");
}
