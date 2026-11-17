import { isAbsolute, resolve } from "node:path";

/** 一个任务被允许触碰的资源；缺省全部拒绝，只能由配置显式放行 */
export interface CapabilitySpec {
  /** 可读目录（相对工作目录或绝对路径）；工作目录本身始终可读 */
  readDirs: string[];
  /** 可写目录；工作目录本身始终可写 */
  writeDirs: string[];
  /** 允许透传给 Worker 的环境变量名 */
  secrets: string[];
  /** 允许访问的域名，子域自动放行 */
  domains: string[];
  /** 允许 GUI 工具与命令 */
  gui: boolean;
}

export interface CapabilitiesConfig {
  /** 全局默认，最大范围；仓库与任务只能在其基础上显式补充 */
  default?: Partial<CapabilitySpec>;
  /** 命名档案，仓库/任务用 profile 引用 */
  profiles?: Record<string, Partial<CapabilitySpec>>;
}

/** 仓库或任务上的能力声明：先选档案，再覆盖字段 */
export interface RepoCapabilities extends Partial<CapabilitySpec> {
  profile?: string;
}

/** 解析后的策略快照：绝对路径、派生出的拒绝清单，随任务记录留存 */
export interface ResolvedCapabilities extends CapabilitySpec {
  workdir: string;
  profile: string | null;
  blockedCommands: string[];
}

export type Verdict = { allow: true } | { allow: false; reason: string; detail: string };

const EMPTY: CapabilitySpec = { readDirs: [], writeDirs: [], secrets: [], domains: [], gui: false };

const OK: Verdict = { allow: true };
const deny = (reason: string, detail: string): Verdict => ({ allow: false, reason: `pisa 策略：${reason}`, detail });

const SAFE_PATHS: Record<string, true> = {
  "/dev/null": true,
  "/dev/stdin": true,
  "/dev/stdout": true,
  "/dev/stderr": true,
};
const SYSTEM_BIN = ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/opt/homebrew/bin"];
const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SHLVL",
  "PWD",
];
const RUNTIME_ENV_PREFIX = /^(OMP_|PI_)/;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE)/i;

const READ_TOOLS: Record<string, true> = { read: true, glob: true, grep: true, lsp: true };
const WRITE_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };
const GUI_TOOLS = /(^|_)(computer|browser|pencil)($|_)/i;

const NETWORK_WORDS: Record<string, true> = {
  curl: true,
  wget: true,
  http: true,
  https: true,
  xh: true,
  nc: true,
  netcat: true,
  ncat: true,
  telnet: true,
  ssh: true,
  scp: true,
  sftp: true,
  rsync: true,
  ftp: true,
  ping: true,
  dig: true,
  nslookup: true,
  host: true,
  whois: true,
};
const GIT_REMOTE: Record<string, true> = { clone: true, fetch: true, pull: true, push: true, "ls-remote": true, submodule: true };
const GUI_COMMAND = /(?:^|[;&|]\s*|\s)(open|osascript|screencapture|xdg-open|wmctrl|xdotool)\b/;

/** 无论能力如何都拒绝：破坏性操作与提权不属于任何任务 */
const HARD_DENY: Array<{ re: RegExp; label: string }> = [
  { re: /(^|[;&|]\s*)git\s+push\b/, label: "git push" },
  { re: /(^|[;&|]\s*)git\s+reset\s+--hard\b/, label: "git reset --hard" },
  { re: /(^|[;&|]\s*)git\s+clean\s+-[a-z]*f/, label: "git clean -f" },
  { re: /\brm\s+-[a-z]*[rf][a-z]*\s+\/(?!tmp)/, label: "rm -rf /" },
  { re: /(^|[;&|]\s*)sudo\b/, label: "sudo" },
  { re: /\b(chmod|chown)\b[^;&|]*\s\/etc\b/, label: "chmod/chown /etc" },
];

function within(root: string, p: string): boolean {
  if (p === root) return true;
  return p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function normalizeDir(workdir: string, dir: string): string {
  if (dir === "~") return resolve(process.env.HOME ?? "/root");
  if (dir.startsWith("~/")) return resolve(process.env.HOME ?? "/root", dir.slice(2));
  return isAbsolute(dir) ? resolve(dir) : resolve(workdir, dir);
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * 解析一个任务的能力：全局默认 → 档案 → 各层覆盖（仓库、任务），后者覆盖前者。
 * 未声明的维度保持拒绝；工作目录始终可读可写。
 */
export function resolveCapabilities(
  cfg: CapabilitiesConfig | undefined,
  workdir: string,
  ...layers: Array<RepoCapabilities | null | undefined>
): ResolvedCapabilities {
  const root = resolve(workdir);
  const spec: CapabilitySpec = { ...EMPTY };
  let profile: string | null = null;

  const apply = (patch?: Partial<CapabilitySpec>) => {
    if (!patch) return;
    if (patch.readDirs) spec.readDirs = patch.readDirs;
    if (patch.writeDirs) spec.writeDirs = patch.writeDirs;
    if (patch.secrets) spec.secrets = patch.secrets;
    if (patch.domains) spec.domains = patch.domains;
    if (patch.gui !== undefined) spec.gui = patch.gui;
  };

  apply(cfg?.default);
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.profile) {
      const named = cfg?.profiles?.[layer.profile];
      if (!named) throw new Error(`未知的能力档案：${layer.profile}`);
      profile = layer.profile;
      apply(named);
    }
    apply(layer);
  }

  const dirs = (values: string[]) => uniq([root, ...values.map((d) => normalizeDir(root, d))]);
  const domains = uniq(spec.domains.map((d) => d.trim().toLowerCase()));

  return {
    workdir: root,
    readDirs: dirs(spec.readDirs),
    writeDirs: dirs(spec.writeDirs),
    secrets: uniq(spec.secrets),
    domains,
    gui: spec.gui,
    profile,
    blockedCommands: blockedCommands(domains, spec.gui),
  };
}

function blockedCommands(domains: string[], gui: boolean): string[] {
  const list = HARD_DENY.map((r) => r.label);
  list.push(domains.length ? `网络访问仅限：${domains.join(", ")}` : "网络命令（curl / wget / ssh / git clone 等）");
  if (!gui) list.push("GUI 工具与命令（computer / browser / open / osascript 等）");
  return list;
}

/**
 * Worker 的环境变量：只带运行必需项，密钥按名单放行，其余（含父进程的
 * PISA_TELEGRAM_TOKEN 一类）一律不传。
 */
export function capabilityEnv(caps: ResolvedCapabilities, base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && RUNTIME_ENV_PREFIX.test(key) && !SECRET_NAME.test(key)) env[key] = value;
  }
  for (const name of caps.secrets) {
    const value = base[name];
    if (value === undefined) throw new Error(`缺少密钥环境变量：${name}`);
    env[name] = value;
  }
  env.PISA_CAPABILITIES = JSON.stringify(caps);
  return env;
}

/** 文件类工具的参数里可能出现的路径字段 */
function pathArgs(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string") out.push(...value.split(";"));
    else if (Array.isArray(value)) for (const v of value) if (typeof v === "string") out.push(...v.split(";"));
  };
  for (const key of ["path", "file_path", "filePath", "target", "paths", "files"]) push(input[key]);
  return out;
}

function checkPath(caps: ResolvedCapabilities, roots: string[], raw: string, mode: string): Verdict {
  let p = raw.trim();
  if (p.startsWith("!")) p = p.slice(1).trim();
  if (!p) return OK;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return OK; // skill:// db:// 等内部资源
  const colon = p.indexOf(":");
  if (colon > 0 && /\.(db|sqlite3?)$/i.test(p.slice(0, colon))) p = p.slice(0, colon); // db.sqlite:table
  const globAt = p.search(/[*?[\]{]/);
  if (globAt >= 0) p = p.slice(0, globAt);
  p = p.trim();
  if (!p || p === ".") return OK;

  const abs = normalizeDir(caps.workdir, p);
  if (SAFE_PATHS[abs]) return OK;
  if (roots.some((root) => within(root, abs))) return OK;
  return deny(`${mode}越界`, abs);
}

function splitWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function segments(words: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const w of words) {
    if (/^[;&|]+$/.test(w)) {
      if (cur.length) out.push(cur);
      cur = [];
      continue;
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

function hostOf(value: string): string | null {
  const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/\s]+)/.exec(value);
  if (url) return (url[1] ?? "").split("@").pop()!.split(":")[0]!.toLowerCase() || null;
  const scp = /^(?:[^@\s]+@)?([\w.-]+\.[\w-]+):/.exec(value);
  if (scp) return (scp[1] ?? "").toLowerCase();
  if (/^[\w.-]+\.[a-z]{2,}$/i.test(value)) return value.toLowerCase();
  return null;
}

function domainAllowed(caps: ResolvedCapabilities, host: string): boolean {
  return caps.domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function checkNetwork(caps: ResolvedCapabilities, command: string, segs: string[][]): Verdict | null {
  const detail = command.slice(0, 160);
  const urls = command.match(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`;|&]+/g) ?? [];
  const hosts = uniq(urls.map(hostOf).filter((h): h is string => Boolean(h)));
  for (const seg of segs) {
    const word = seg[0] ?? "";
    const networked = Boolean(NETWORK_WORDS[word]) || (word === "git" && Boolean(GIT_REMOTE[seg[1] ?? ""]));
    if (!networked) continue;
    if (!caps.domains.length) return deny("未授权网络访问", detail);
    for (const token of seg.slice(1)) {
      if (token.startsWith("-")) continue;
      const host = hostOf(token);
      if (host) hosts.push(host);
    }
    // git 远端名（origin 等）由仓库配置决定，不在命令里暴露，域名非空即放行
    if (!hosts.length && word !== "git") return deny("无法确认网络目标", detail);
  }
  for (const host of uniq(hosts)) {
    if (!domainAllowed(caps, host)) return deny(`域名未授权：${host}`, detail);
  }
  return null;
}

function checkPathTokens(caps: ResolvedCapabilities, words: string[]): Verdict | null {
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!;
    if (raw.includes("://")) continue;
    const looksAbsolute = raw.startsWith("/") || raw.startsWith("~");
    const looksRelative = raw.startsWith("./") || raw.startsWith("../") || raw === ".." || raw.includes("/../");
    if (!looksAbsolute && !looksRelative) continue;
    const abs = normalizeDir(caps.workdir, raw);
    if (SAFE_PATHS[abs]) continue;
    if (i === 0 && SYSTEM_BIN.some((dir) => within(dir, abs))) continue;
    if (caps.readDirs.some((root) => within(root, abs))) continue;
    return deny("路径越界", abs);
  }
  return null;
}

/** 显式写入目标：重定向、tee、mkdir、cp/mv 等命令的落点 */
function writeTargets(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?:^|[^>])>{1,2}\s*([^\s;&|]+)/g)) out.push(m[1]!);
  for (const m of command.matchAll(/(?:^|[;&|]\s*)\s*tee\b([^;&|]*)/g)) {
    out.push(...splitWords(m[1]!).filter((w) => !w.startsWith("-")));
  }
  for (const m of command.matchAll(/(?:^|[;&|]\s*)\s*mkdir\b([^;&|]*)/g)) {
    out.push(...splitWords(m[1]!).filter((w) => !w.startsWith("-")));
  }
  for (const m of command.matchAll(/(?:^|[;&|]\s*)\s*(?:cp|mv|ln|install|rsync)\b([^;&|]*)/g)) {
    const words = splitWords(m[1]!).filter((w) => !w.startsWith("-"));
    const last = words[words.length - 1];
    if (last) out.push(last);
  }
  for (const m of command.matchAll(/\bdd\b[^;&|]*\bof=(\S+)/g)) out.push(m[1]!);
  return out.filter((t) => t && !hostOf(t));
}

function checkWrites(caps: ResolvedCapabilities, command: string): Verdict | null {
  for (const target of writeTargets(command)) {
    const abs = normalizeDir(caps.workdir, target);
    if (SAFE_PATHS[abs]) continue;
    if (caps.writeDirs.some((root) => within(root, abs))) continue;
    return deny("写入越界", abs);
  }
  return null;
}

/** bash 命令的能力检查：硬拒绝 → GUI → 网络 → 路径 → 写目标 */
export function checkBashCommand(caps: ResolvedCapabilities, command: string): Verdict {
  const cmd = command.replace(/\s+/g, " ").trim();
  if (!cmd) return OK;
  for (const rule of HARD_DENY) {
    if (rule.re.test(cmd)) return deny(`禁止命令 ${rule.label}`, cmd.slice(0, 160));
  }
  if (!caps.gui && GUI_COMMAND.test(cmd)) return deny("GUI 未授权", cmd.slice(0, 160));

  const words = splitWords(cmd);
  const segs = segments(words);
  return checkNetwork(caps, cmd, segs) ?? checkPathTokens(caps, words) ?? checkWrites(caps, cmd) ?? OK;
}

/** 任意工具调用的能力检查；未涉及能力的工具直接放行（MCP 等不在管辖范围） */
export function checkToolCall(
  caps: ResolvedCapabilities,
  tool: string,
  input: Record<string, unknown> = {},
): Verdict {
  if (GUI_TOOLS.test(tool) && !caps.gui) return deny("GUI 未授权", tool);
  if (tool === "bash") return checkBashCommand(caps, String(input["command"] ?? ""));
  if (READ_TOOLS[tool] || WRITE_TOOLS[tool]) {
    const write = Boolean(WRITE_TOOLS[tool]);
    const roots = write ? caps.writeDirs : caps.readDirs;
    for (const raw of pathArgs(input)) {
      const verdict = checkPath(caps, roots, raw, write ? "写" : "读");
      if (!verdict.allow) return verdict;
    }
  }
  return OK;
}
