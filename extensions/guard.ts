// Worker 边界判定：纯函数，不执行 git、不读文件内容、不注册扩展。
// pisa-worker.ts 只负责事件接线；测试直接 import 本模块。
//
// 三种判定来源：
// 1. 固定拒绝列表（git 危险操作、sudo、删根、改 /etc 权限）
// 2. 能力策略（readPaths / domains / gui）：未声明的默认拒绝
// 3. 文件工具路径：读走 readPaths，写只允许 workdir 与临时目录

import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** 能力策略；缺省字段等价于全部拒绝 */
export interface GuardPolicy {
  readPaths?: readonly string[];
  domains?: readonly string[];
  gui?: boolean;
}

export type ResolvedPolicy = Required<GuardPolicy>;

export const DENY_ALL_POLICY: ResolvedPolicy = { readPaths: [], domains: [], gui: false };

/** 任务清单里展示的固定被禁类别，与下面的实现逐条对应 */
export const BLOCKED_RULES: readonly string[] = [
  "git push / rebase / reset --hard / clean -f / 切换分支 / worktree remove|prune / 删除分支 / commit --amend",
  "sudo、删除根目录、chmod/chown /etc",
  "写入工作目录与临时目录之外",
  "读取能力清单之外的路径",
  "访问域名清单之外的网络目标",
  "GUI 操作（capabilities.gui=false）",
];

/** 执行命令必然要读的系统目录，作为隐含只读范围 */
const AMBIENT_READ_ROOTS = [
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/opt",
  "/System",
  "/Library",
  "/etc/ssl",
  "/dev",
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
];

function toAbs(p: string, workdir: string): string {
  const expanded = p === "~" ? homedir() : p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(workdir || ".", expanded);
}

function within(p: string, root: string): boolean {
  const rel = relative(resolve(root), p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 可写范围：工作目录与系统临时目录；两者都为空时视为不可写 */
export function writableDirs(workdir: string): string[] {
  // /tmp 在 macOS 上是指向 /private/tmp 的符号链接，两边都算
  return [workdir, tmpdir(), "/tmp", "/private/tmp"].filter((r) => r !== "");
}

/** path 解析后落在 workdir 之外时返回原因，否则 null */
export function outsideWorkdir(p: string, workdir: string): string | null {
  if (!workdir) return `工作目录未知，无法校验路径：${p}`;
  const root = resolve(workdir);
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "" || rel === ".") return null;
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return `路径在工作目录之外：${p}`;
  }
  return null;
}

/** 生效的可读范围：可写目录 + 能力清单 + 系统目录 */
export function readableDirs(workdir: string, readPaths: readonly string[] = []): string[] {
  return [...writableDirs(workdir), ...readPaths.map((p) => toAbs(p, workdir)), ...AMBIENT_READ_ROOTS];
}

/**
 * 文件工具路径判定：write 只允许 workdir 与临时目录；
 * read 允许 workdir、临时目录、系统目录与能力清单 readPaths。
 */
export function checkPath(
  p: string,
  workdir: string,
  readPaths: readonly string[] = [],
  mode: "read" | "write" = "read",
): string | null {
  if (!workdir) return `工作目录未知，无法校验路径：${p}`;
  const abs = toAbs(p, workdir);
  const roots = writableDirs(workdir);
  if (mode === "write") {
    return roots.some((r) => within(abs, r)) ? null : `写入范围之外（只允许工作目录与临时目录）：${p}`;
  }
  if (within(abs, resolve(workdir))) return null;
  return readableDirs(workdir, readPaths).some((r) => within(abs, r))
    ? null
    : `读取范围之外（未在能力清单 readPaths 中）：${p}`;
}

/** 从 PISA_CAPABILITIES 解析策略；缺失或损坏时全拒 */
export function parsePolicy(json?: string | null): ResolvedPolicy {
  if (!json) return { ...DENY_ALL_POLICY, readPaths: [], domains: [] };
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return {
      readPaths: strings(raw.readPaths),
      domains: strings(raw.domains),
      gui: raw.gui === true,
    };
  } catch {
    return { ...DENY_ALL_POLICY, readPaths: [], domains: [] };
  }
}

const GUI_TOOL = /^(browser|computer|screenshot|screen|mouse|keyboard|gui|display)/i;

/** GUI 类工具（浏览器、桌面操作）需要 capabilities.gui=true */
export function blockTool(name: string, policy: GuardPolicy = {}): string | null {
  if (policy.gui) return null;
  return GUI_TOOL.test(name) ? `GUI 工具未放行（capabilities.gui=false）：${name}` : null;
}

/** 空白只断词；这些字符断段。引号内的字符不参与 */
const SEGMENT_SEPARATORS = "\n\r;|&()`";
const WORD_SEPARATORS = " \t";

/** 按分隔符切段并切词，引号内容保留为一个词（`bash -c "git push"` 会得到一个含空格的词） */
function segments(cmd: string): string[][] {
  const out: string[][] = [];
  let seg: string[] = [];
  let word = "";
  let quote: string | null = null;

  const endWord = () => {
    if (word) seg.push(word);
    word = "";
  };
  const endSeg = () => {
    endWord();
    if (seg.length) out.push(seg);
    seg = [];
  };

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < cmd.length) word += cmd[++i]!;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < cmd.length) {
      word += cmd[++i]!;
      continue;
    }
    if (SEGMENT_SEPARATORS.includes(ch)) {
      endSeg();
      continue;
    }
    if (WORD_SEPARATORS.includes(ch)) {
      endWord();
      continue;
    }
    word += ch;
  }
  endSeg();
  return out;
}

/** git 全局选项中带值的项；`-C` 还能把仓库指到 workdir 之外 */
const GIT_VALUE_OPTS: Record<string, true> = {
  "-c": true,
  "-C": true,
  "--git-dir": true,
  "--work-tree": true,
  "--namespace": true,
  "--super-prefix": true,
  "--exec-path": true,
  "--config-env": true,
  "--attr-source": true,
};

const GIT_PATH_OPTS = ["-C", "--work-tree", "--git-dir"];

interface GitCommand {
  sub: string;
  args: string[];
  reason: string | null;
}

/** 剥离全局选项，返回子命令与剩余参数；路径型全局选项越界时 reason 非空 */
function parseGit(args: string[], workdir: string): GitCommand {
  let reason: string | null = null;
  const outside = (opt: string, value: string) => {
    const hit = outsideWorkdir(value, workdir);
    if (hit && !reason) reason = `${opt} ${hit}`;
  };

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    if (tok === "--") {
      return { sub: args[i + 1] ?? "", args: args.slice(i + 2), reason };
    }
    if (!tok.startsWith("-")) {
      return { sub: tok, args: args.slice(i + 1), reason };
    }
    if (GIT_VALUE_OPTS[tok]) {
      const value = args[i + 1];
      if (value !== undefined) {
        if (GIT_PATH_OPTS.includes(tok)) outside(tok, value);
        i++;
      }
      continue;
    }
    if (tok.startsWith("-C") && tok.length > 2) {
      outside("-C", tok.slice(2)); // git 支持 -C<path> 紧贴写法
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq > 0) {
      const opt = tok.slice(0, eq);
      if (GIT_PATH_OPTS.includes(opt)) outside(opt, tok.slice(eq + 1));
    }
  }
  return { sub: "", args: [], reason };
}

function checkGit(args: string[], workdir: string): string | null {
  const { sub, args: rest, reason } = parseGit(args, workdir);
  if (reason) return reason;
  const has = (pred: (t: string) => boolean) => rest.some(pred);
  const flagWithF = (t: string) =>
    t === "--force" || (t.startsWith("-") && !t.startsWith("--") && t.includes("f"));

  switch (sub) {
    case "push":
      return "禁止 git push";
    case "rebase":
      return "禁止 git rebase";
    case "reset":
      return has((t) => t.startsWith("--hard")) ? "禁止 git reset --hard" : null;
    case "clean":
      return has(flagWithF) ? "禁止 git clean -f" : null;
    case "checkout":
      return rest.length === 0 || rest[0] === "--" ? null : "禁止切换分支；只允许 git checkout -- <path> 恢复文件";
    case "switch":
      return rest.length === 0 ? null : "禁止切换分支";
    case "worktree":
      return rest[0] === "remove" || rest[0] === "prune" ? "禁止 git worktree remove/prune" : null;
    case "branch":
      return has((t) => t === "-D" || t === "-d" || t === "--delete") ? "禁止删除分支" : null;
    case "commit":
      return has((t) => t.startsWith("--amend")) ? "禁止 git commit --amend" : null;
    default:
      return null;
  }
}

const WRAPPERS: Record<string, true> = {
  command: true,
  exec: true,
  env: true,
  nohup: true,
  nice: true,
  time: true,
};

/** 位置参数都是写入目标的命令 */
const WRITE_ARG_COMMANDS: Record<string, true> = {
  rm: true,
  rmdir: true,
  mkdir: true,
  touch: true,
  tee: true,
  truncate: true,
  shred: true,
  chmod: true,
  chown: true,
};

/** 最后一个位置参数是写入目标、其余为读取来源的命令 */
const WRITE_LAST_COMMANDS: Record<string, true> = {
  cp: true,
  mv: true,
  ln: true,
  install: true,
  rsync: true,
};

/** 需要网络、且目标可以静态识别的命令 */
const NETWORK_HEADS: Record<string, true> = {
  curl: true,
  wget: true,
  aria2c: true,
  nc: true,
  ncat: true,
  netcat: true,
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
  traceroute: true,
};

const GUI_HEADS: Record<string, true> = {
  open: true,
  osascript: true,
  screencapture: true,
  cliclick: true,
  xdotool: true,
  wmctrl: true,
  "xdg-open": true,
  scrot: true,
};

/** 重定向 token：`>`、`>>`、`2>`、`&>`，返回目标文本（可能为空，目标在下一个 token） */
const REDIRECT = /^(?:[0-9]*>>?|&>)(.*)$/;

const SAFE_WRITE_TARGETS: Record<string, true> = {
  "/dev/null": true,
  "/dev/zero": true,
  "/dev/stdout": true,
  "/dev/stderr": true,
  "/dev/tty": true,
};

function looksLikePath(t: string): boolean {
  if (t === "" || t === "-" || t.includes("://")) return false;
  if (t.startsWith("-")) {
    const eq = t.indexOf("=");
    return eq > 0 && looksLikePath(t.slice(eq + 1));
  }
  return (
    t.startsWith("/") ||
    t === "~" ||
    t.startsWith("~/") ||
    t === "." ||
    t === ".." ||
    t.startsWith("./") ||
    t.startsWith("../") ||
    t.includes("/")
  );
}

function stripWrappers(tokens: string[]): string[] {
  let at = 0;
  while (
    at < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[at]!) || WRAPPERS[tokens[at]!])
  ) {
    at++;
  }
  return tokens.slice(at);
}

function checkWrites(tokens: string[], workdir: string, policy: GuardPolicy): string | null {
  const readPaths = policy.readPaths ?? [];
  const head = stripWrappers(tokens)[0] ?? "";

  const writePaths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const red = REDIRECT.exec(tok);
    if (red) {
      const target = red[1] || tokens[i + 1] || "";
      if (!red[1] && tokens[i + 1]) i++;
      // fd 复制（2>&1）与设备文件不是受管写入目标
      if (!target || target.startsWith("&") || SAFE_WRITE_TARGETS[target]) continue;
      const hit = checkPath(target, workdir, readPaths, "write");
      if (hit) return hit;
      continue;
    }
    if (looksLikePath(tok)) writePaths.push(tok);
  }

  if (WRITE_ARG_COMMANDS[head]) {
    for (const p of writePaths) {
      const hit = checkPath(p, workdir, readPaths, "write");
      if (hit) return hit;
    }
  } else if (WRITE_LAST_COMMANDS[head]) {
    const last = writePaths[writePaths.length - 1];
    if (last) {
      const hit = checkPath(last, workdir, readPaths, "write");
      if (hit) return hit;
    }
  }
  return null;
}

function checkReads(tokens: string[], workdir: string, policy: GuardPolicy): string | null {
  const readPaths = policy.readPaths ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (REDIRECT.test(tok)) {
      if (!REDIRECT.exec(tok)![1]) i++; // 跳过重定向目标
      continue;
    }
    if (!looksLikePath(tok)) continue;
    const hit = checkPath(tok, workdir, readPaths, "read");
    if (hit) return hit;
  }
  return null;
}

function hostOf(token: string): string | null {
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(token);
  const raw = url ? url[1]! : (/^[^\s@/]+@([\w.-]+):/.exec(token)?.[1] ?? null);
  if (!raw) return null;
  const host = raw.replace(/^.*@/, "");
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]") + 1) || host;
  return host.split(":")[0] || null;
}

function checkNetwork(tokens: string[], policy: GuardPolicy): string | null {
  const domains = policy.domains ?? [];
  const head = stripWrappers(tokens)[0] ?? "";
  const isNetwork = NETWORK_HEADS[head] === true;
  const allowed = (host: string) => {
    const h = host.toLowerCase();
    return domains.some((d) => h === d.toLowerCase() || h.endsWith(`.${d.toLowerCase()}`));
  };

  if (!isNetwork) {
    // 非网络命令也检查显式 URL：`bun -e "fetch('https://…')"`、`git clone https://…`
    for (const tok of tokens) {
      const host = hostOf(tok);
      if (host && !allowed(host)) return `网络目标不在能力清单：${host}`;
    }
    return null;
  }

  const hosts = tokens.map(hostOf).filter((h): h is string => h !== null);
  if (hosts.length === 0) {
    // `ssh deploy@host` / `ping host` 这类没有 scheme 的目标
    for (const tok of tokens) {
      if (tok === head || tok.startsWith("-") || looksLikePath(tok) || tok.includes("://")) continue;
      if (/^([\w.-]+@)?[\w.-]+$/.test(tok)) hosts.push(tok.replace(/^.*@/, ""));
    }
  }
  if (hosts.length === 0) return `无法确认网络目标，拒绝执行：${head}`;
  for (const h of hosts) {
    if (!allowed(h)) return `网络目标不在能力清单：${h}`;
  }
  return null;
}

function checkSegment(
  tokens: string[],
  workdir: string,
  depth: number,
  policy: GuardPolicy,
): string | null {
  const rest = stripWrappers(tokens);
  const head = rest[0] ?? "";

  if (head === "sudo") return "禁止 sudo";
  if (head === "rm" && rest.some((t) => t === "/" || t.startsWith("/*"))) {
    return "禁止删除根目录";
  }
  if (
    (head === "chmod" || head === "chown") &&
    rest.some((t) => t === "/etc" || t.startsWith("/etc/"))
  ) {
    return `禁止 ${head} /etc`;
  }
  if (head === "git") {
    const hit = checkGit(rest.slice(1), workdir);
    if (hit) return hit;
  }
  if (!policy.gui && GUI_HEADS[head]) {
    return `GUI 操作未放行（capabilities.gui=false）：${head}`;
  }

  const write = checkWrites(tokens, workdir, policy);
  if (write) return write;
  const read = checkReads(tokens, workdir, policy);
  if (read) return read;
  const net = checkNetwork(tokens, policy);
  if (net) return net;

  // `bash -c "git push"`、`$(...)`、反引号：含空格的词当命令再判一次
  if (depth < 2) {
    for (const tok of tokens) {
      if (!/\s/.test(tok)) continue;
      const hit = scan(tok, workdir, depth + 1, policy);
      if (hit) return hit;
    }
  }
  return null;
}

function scan(cmd: string, workdir: string, depth: number, policy: GuardPolicy): string | null {
  for (const seg of segments(cmd)) {
    const hit = checkSegment(seg, workdir, depth, policy);
    if (hit) return hit;
  }
  return null;
}

/**
 * 命中返回原因，放行返回 null。
 * workdir 用于判定路径边界；policy 缺省等价全拒（见 DENY_ALL_POLICY）。
 */
export function blockBash(cmd: string, workdir: string, policy: GuardPolicy = DENY_ALL_POLICY): string | null {
  return scan(cmd, workdir, 0, policy);
}
