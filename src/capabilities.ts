// Runtime 能力声明：默认全拒，只有显式列出的资源可用。
// 纯函数、不读进程环境，配置解析与任务落库各调一次。

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** 配置里写的形状；目录可以是绝对路径、相对配置文件目录的路径或 `~/...` */
export interface CapabilityConfig {
  /** 工作目录之外允许读的目录 */
  readDirs?: string[];
  /** 工作目录之外允许写的目录（写包含读） */
  writeDirs?: string[];
  /** 允许从宿主继承的环境变量名（凭据） */
  env?: string[];
  /** 允许访问的域名；空表示禁止一切联网命令 */
  domains?: string[];
  /** 是否允许启动 GUI 应用（open/osascript/xdg-open） */
  gui?: boolean;
  /** 额外禁止的命令名（首个词） */
  blockedCommands?: string[];
}

/** 归一化后的能力：目录是绝对路径，域名已小写并去掉 `*.` */
export interface Capabilities {
  readDirs: string[];
  writeDirs: string[];
  env: string[];
  domains: string[];
  gui: boolean;
  blockedCommands: string[];
}

/** 一个任务实际生效的能力清单；写进 tasks.capabilities，也是扩展的输入 */
export interface RuntimeManifest {
  workdir: string;
  /** 可读目录，含 workdir 与 writeDirs */
  readDirs: string[];
  writeDirs: string[];
  /** 实际从宿主继承的变量名 */
  env: string[];
  domains: string[];
  gui: boolean;
  blockedCommands: string[];
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  readDirs: [],
  writeDirs: [],
  env: [],
  domains: [],
  gui: false,
  blockedCommands: [],
};

function strings(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const item = value.trim();
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

function expandDir(dir: string, baseDir: string): string {
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return resolve(homedir(), dir.slice(2));
  return isAbsolute(dir) ? resolve(dir) : resolve(baseDir, dir);
}

/** 展开后去重：`data` 与 `./data` 是同一个目录 */
function dirsOf(values: readonly string[] | undefined, baseDir: string): string[] {
  const out: string[] = [];
  for (const value of strings(values)) {
    const dir = expandDir(value, baseDir);
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

function domainsOf(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of strings(values)) {
    const domain = raw.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    if (domain && !out.includes(domain)) out.push(domain);
  }
  return out;
}

/** 配置 → 能力；目录相对配置文件所在目录解析 */
export function normalizeCapabilities(raw: CapabilityConfig | undefined, baseDir: string): Capabilities {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CAPABILITIES };
  return {
    readDirs: dirsOf(raw.readDirs, baseDir),
    writeDirs: dirsOf(raw.writeDirs, baseDir),
    env: strings(raw.env),
    domains: domainsOf(raw.domains),
    gui: raw.gui === true,
    blockedCommands: strings(raw.blockedCommands),
  };
}

/** 有序并集：保留 a 的顺序，b 只补充缺项 */
function union(a: readonly string[], b: readonly string[]): string[] {
  return [...a, ...b.filter((x) => !a.includes(x))];
}

/** 允许项取并集、gui 取或、禁止项取并集：声明只能加，不能收窄 */
export function mergeCapabilities(base: Capabilities, patch: Capabilities | undefined): Capabilities {
  if (!patch) return base;
  return {
    readDirs: union(base.readDirs, patch.readDirs),
    writeDirs: union(base.writeDirs, patch.writeDirs),
    env: union(base.env, patch.env),
    domains: union(base.domains, patch.domains),
    gui: base.gui || patch.gui,
    blockedCommands: union(base.blockedCommands, patch.blockedCommands),
  };
}

/** 部署默认 + 仓库声明；顺序固定，后者只能补充 */
export function capabilitiesFor(...layers: Array<Capabilities | undefined>): Capabilities {
  return layers.reduce<Capabilities>((acc, layer) => mergeCapabilities(acc, layer), DEFAULT_CAPABILITIES);
}

/** 任务清单：readDirs 含 writeDirs（写包含读），env 是白名单与声明的并集 */
export function runtimeManifest(
  caps: Capabilities,
  input: { workdir: string; env: readonly string[] },
): RuntimeManifest {
  const writeDirs = union([input.workdir], caps.writeDirs);
  return {
    workdir: input.workdir,
    readDirs: union(writeDirs, caps.readDirs),
    writeDirs,
    env: union(input.env, caps.env),
    domains: [...caps.domains],
    gui: caps.gui,
    blockedCommands: [...caps.blockedCommands],
  };
}

/** 从 JSON（字符串或已解析值）恢复清单；结构不完整视为缺失，调用方按默认全拒处理 */
export function parseManifest(raw: unknown): RuntimeManifest | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  const m = value as Partial<RuntimeManifest> | null;
  if (!m || typeof m !== "object" || typeof m.workdir !== "string") return null;
  const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  if (!isStrings(m.readDirs) || !isStrings(m.writeDirs) || !isStrings(m.env)) return null;
  if (!isStrings(m.domains) || !isStrings(m.blockedCommands) || typeof m.gui !== "boolean") return null;
  return {
    workdir: m.workdir,
    readDirs: m.readDirs,
    writeDirs: m.writeDirs,
    env: m.env,
    domains: m.domains,
    gui: m.gui,
    blockedCommands: m.blockedCommands,
  };
}

const NONE = "无";

/** 单行摘要：启动日志按仓库打印声明，任务日志按实际清单打印，字段一致 */
export function describeCapabilities(caps: Capabilities): string {
  const list = (values: readonly string[]) => (values.length ? values.join(",") : NONE);
  return [
    `可写 ${list(caps.writeDirs)}`,
    `可读 ${list(caps.readDirs)}`,
    `密钥 ${list(caps.env)}`,
    `域名 ${list(caps.domains)}`,
    `GUI ${caps.gui ? "开" : "关"}`,
    `禁止命令 ${list(caps.blockedCommands)}`,
  ].join(" · ");
}
