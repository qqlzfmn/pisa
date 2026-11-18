// 任务能力清单：解析配置、合并继承、生成 env 与落盘清单。
// 判定实现在 extensions/guard.ts；本模块只负责「这个任务被授予了什么」。

import { BLOCKED_RULES, readableDirs, writableDirs } from "../extensions/guard";

export interface Capabilities {
  /** 工作目录之外允许读取的路径（相对路径以工作目录为基准） */
  readPaths: string[];
  /** 允许从父进程继承的环境变量名（密钥） */
  secrets: string[];
  /** 允许访问的域名，子域自动放行 */
  domains: string[];
  /** 是否允许 GUI / 浏览器操作 */
  gui: boolean;
}

export type CapabilityPatch = Partial<Capabilities>;

export const DENY_ALL: Capabilities = { readPaths: [], secrets: [], domains: [], gui: false };

export interface CapabilitySources {
  /** 全局基线（worker.capabilities） */
  global?: CapabilityPatch;
  /** 仓库基线（repos[].capabilities） */
  repo?: CapabilityPatch;
  /** 任务档位（repos[].profiles） */
  profiles?: Record<string, CapabilityPatch>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** 数组取并集、gui 取或；缺省字段保持空 */
export function mergeCapabilities(...layers: Array<CapabilityPatch | null | undefined>): Capabilities {
  const out: Capabilities = { readPaths: [], secrets: [], domains: [], gui: false };
  for (const layer of layers) {
    if (!layer) continue;
    out.readPaths = unique([...out.readPaths, ...(layer.readPaths ?? [])]);
    out.secrets = unique([...out.secrets, ...(layer.secrets ?? [])]);
    out.domains = unique([...out.domains, ...(layer.domains ?? [])]);
    out.gui = out.gui || layer.gui === true;
  }
  return out;
}

/** 档位名必须存在；不存在时抛错，错误文本由建任务与执行两处共用 */
export function assertProfile(profile: string, profiles?: Record<string, CapabilityPatch>): void {
  if (profiles?.[profile]) return;
  const names = Object.keys(profiles ?? {});
  throw new Error(
    `未知能力档位：${profile}${names.length ? `（可选：${names.join(", ")}）` : "（仓库未配置 profiles）"}`,
  );
}

/**
 * 档位存在时替换仓库基线（并集无法收紧权限，替换才能写出更严的档位），
 * 再与全局基线合并。
 */
export function resolveCapabilities(sources: CapabilitySources, profile?: string | null): Capabilities {
  let layer = sources.repo;
  if (profile) {
    assertProfile(profile, sources.profiles);
    layer = sources.profiles![profile];
  }
  return mergeCapabilities(sources.global, layer);
}

export interface CapabilityManifest {
  taskId: string;
  profile: string | null;
  workdir: string;
  /** 实际生效的可读目录（含工作目录、临时目录与系统目录） */
  readPaths: string[];
  /** 实际可写目录 */
  writable: string[];
  /** 只写变量名，不写值 */
  secrets: string[];
  domains: string[];
  gui: boolean;
  /** 被禁的命令类别，供人和代理阅读 */
  blocked: string[];
}

export function buildManifest(input: {
  taskId: string;
  profile: string | null;
  workdir: string;
  capabilities: Capabilities;
}): CapabilityManifest {
  const { taskId, profile, workdir, capabilities } = input;
  return {
    taskId,
    profile,
    workdir,
    readPaths: readableDirs(workdir, capabilities.readPaths),
    writable: writableDirs(workdir),
    secrets: capabilities.secrets,
    domains: capabilities.domains,
    gui: capabilities.gui,
    blocked: [...BLOCKED_RULES],
  };
}

/** 子进程环境：只带判定所需字段，不带密钥值 */
export function capabilityEnv(manifest: CapabilityManifest): Record<string, string> {
  return {
    PISA_CAPABILITIES: JSON.stringify({
      taskId: manifest.taskId,
      readPaths: manifest.readPaths,
      domains: manifest.domains,
      gui: manifest.gui,
    }),
  };
}

/** 把密钥名并进 env 白名单 */
export function envAllowWithSecrets(allow: readonly string[], secrets: readonly string[]): string[] {
  return unique([...allow, ...secrets]);
}
