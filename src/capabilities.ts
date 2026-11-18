import { isAbsolute, relative, resolve, sep } from "node:path";

export interface CapabilitySpec {
  read?: string[];
  write?: string[];
  secrets?: string[];
  domains?: string[];
  gui?: boolean;
  deny?: string[];
}

export interface RuntimeCapabilities {
  workdir: string;
  read: string[];
  write: string[];
  secrets: string[];
  domains: string[];
  gui: boolean;
  deny: string[];
  blocked: string[];
}

export const BUILTIN_BLOCKED = [
  "sudo",
  "git push",
  "git reset --hard",
  "git clean -f",
  "切换分支 / worktree remove / branch -D / rebase / commit --amend",
  "读写声明目录之外的路径",
  "访问未声明域名的联网命令",
  "未开启 GUI 时的 GUI 命令",
] as const;

const dedupe = (items: string[]): string[] => [...new Set(items.filter(Boolean))];

export function defaultRuntime(workdir: string): RuntimeCapabilities {
  const root = workdir ? resolve(workdir) : "";
  return {
    workdir: root,
    read: root ? [root] : [],
    write: root ? [root] : [],
    secrets: [],
    domains: [],
    gui: false,
    deny: [],
    blocked: [...BUILTIN_BLOCKED],
  };
}

function cleanList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return out;
}

export function parseCapabilitySpec(value: unknown): CapabilitySpec | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const spec: CapabilitySpec = {};
  const read = cleanList(raw.read);
  const write = cleanList(raw.write);
  const secrets = cleanList(raw.secrets);
  const domains = cleanList(raw.domains);
  const deny = cleanList(raw.deny);
  if (read) spec.read = read;
  if (write) spec.write = write;
  if (secrets) spec.secrets = secrets;
  if (domains) spec.domains = domains;
  if (deny) spec.deny = deny;
  if (typeof raw.gui === "boolean") spec.gui = raw.gui;
  return spec;
}

export function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      return "";
    }
  }
  return trimmed.replace(/\.$/, "");
}

export function hostAllowed(host: string, domains: string[]): boolean {
  const target = host.trim().toLowerCase().replace(/\.$/, "");
  if (!target) return false;
  return domains.some((domain) => {
    if (domain.startsWith("*.")) {
      const suffix = domain.slice(1);
      return target.length > suffix.length && target.endsWith(suffix);
    }
    return target === domain;
  });
}

export function outsideRoots(path: string, roots: string[], base: string): string | null {
  if (!base) return `工作目录未知，无法校验路径：${path}`;
  const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const inside = roots.some((root) => {
    const rel = relative(root, absolute);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
  return inside ? null : `路径超出可访问目录：${path}`;
}

export function resolveCapabilities(
  workdir: string,
  baseDir: string | undefined,
  spec: CapabilitySpec | null | undefined,
): RuntimeCapabilities {
  const root = workdir ? resolve(workdir) : "";
  const base = root || (baseDir ? resolve(baseDir) : "");
  const writeSpec = (spec?.write ?? []).map((path) =>
    isAbsolute(path) ? resolve(path) : base ? resolve(base, path) : path,
  );
  const readSpec = (spec?.read ?? []).map((path) =>
    isAbsolute(path) ? resolve(path) : base ? resolve(base, path) : path,
  );
  const write = dedupe([...(root ? [root] : []), ...writeSpec]);
  const read = dedupe([...write, ...readSpec]);
  const domains = dedupe((spec?.domains ?? []).map(normalizeDomain));
  const deny = dedupe(spec?.deny ?? []);

  return {
    workdir: root,
    read,
    write,
    secrets: dedupe(spec?.secrets ?? []),
    domains,
    gui: spec?.gui === true,
    deny,
    blocked: [...BUILTIN_BLOCKED, ...deny.map((entry) => `自定义禁止：${entry}`)],
  };
}
