// Worker 边界判定：纯函数，不执行 git、不读文件系统、不注册扩展。
// pisa-worker.ts 只负责事件接线；测试直接 import 本模块。
//
// 默认拒绝：没写进 policy 的目录不可读写，没写进 domains 的域名不可访问，
// gui 为 false 时不可启动 GUI 应用。声明来自 tasks.capabilities（见 src/capabilities.ts）。

import { isAbsolute, relative, resolve, sep } from "node:path";

export interface GuardPolicy {
  workdir: string;
  /** 工作目录之外允许读的目录 */
  readDirs?: readonly string[];
  /** 工作目录之外允许写的目录（写包含读） */
  writeDirs?: readonly string[];
  /** 允许访问的域名；空表示禁止一切可判定的联网命令。回环地址始终放行 */
  domains?: readonly string[];
  /** 是否允许启动 GUI 应用（open / osascript / xdg-open） */
  gui?: boolean;
  /** 额外禁止的命令名（首个词） */
  blockedCommands?: readonly string[];
}

/** 设备节点不需要落在目录内：`2>/dev/null`、`< /dev/stdin` 是常规写法 */
const DEVICE_PATHS: Record<string, true> = {
  "/dev/null": true,
  "/dev/zero": true,
  "/dev/stdin": true,
  "/dev/stdout": true,
  "/dev/stderr": true,
  "/dev/tty": true,
  "/dev/random": true,
  "/dev/urandom": true,
};

function isDevice(abs: string): boolean {
  return DEVICE_PATHS[abs] === true || abs.startsWith("/dev/fd/");
}

/** root 包含 abs（或就是 abs） */
function contains(root: string, abs: string): boolean {
  const rel = relative(resolve(root), abs);
  return rel === "" || rel === "." || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** 路径不在 roots 内时返回原因；相对路径按 workdir 解析 */
function escapes(p: string, policy: GuardPolicy, roots: readonly string[], label: "读" | "写"): string | null {
  if (!policy.workdir) return `工作目录未知，无法校验路径：${p}`;
  const abs = isAbsolute(p) ? resolve(p) : resolve(policy.workdir, p);
  if (isDevice(abs)) return null;
  if (roots.some((root) => root && contains(root, abs))) return null;
  return `路径不可${label}：${p}（不在工作目录或放行目录内）`;
}

/** 读目录 = workdir + writeDirs + readDirs */
export function outsideReadable(p: string, policy: GuardPolicy): string | null {
  const roots = [policy.workdir, ...(policy.writeDirs ?? []), ...(policy.readDirs ?? [])];
  return escapes(p, policy, roots, "读");
}

/** 写目录 = workdir + writeDirs */
export function outsideWritable(p: string, policy: GuardPolicy): string | null {
  const roots = [policy.workdir, ...(policy.writeDirs ?? [])];
  return escapes(p, policy, roots, "写");
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
function parseGit(args: string[], policy: GuardPolicy): GitCommand {
  let reason: string | null = null;
  const outside = (opt: string, value: string) => {
    const hit = outsideReadable(value, policy);
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

/** 形如 `https://host/...`、`host:22`、`example.com/x` 的目标；不含点、不像 URL 的短词返回 null */
const URLISH = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d+)?(?:[/?#]|$)/i;

function hostOf(target: string): string | null {
  let text = target.trim();
  const scheme = text.indexOf("://");
  if (scheme >= 0) text = text.slice(scheme + 3);
  text = text.replace(/^[^@/]*@/, ""); // user@host:path
  text = text.split("/")[0] ?? "";
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    return end > 0 ? text.slice(1, end).toLowerCase() : null;
  }
  const host = text.split(":")[0] ?? "";
  return host ? host.toLowerCase().replace(/\.$/, "") : null;
}

/** 裸主机名：`curl example.com`、`ssh host:2222`；不含点的词是选项值或参数 */
const HOSTISH = /^(?:localhost|\[[0-9a-fA-F:.]+\]|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)(?::\d+)?$/;

const LOOPBACK = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];

function hostAllowed(host: string, domains: readonly string[]): boolean {
  if (LOOPBACK.includes(host)) return true;
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

const URL_COMMANDS: Record<string, true> = { curl: true, wget: true, http: true, https: true, xh: true };

/** 命令行里只出现主机名或用户@主机：路径的命令 */
const HOST_COMMANDS: Record<string, true> = {
  ssh: true,
  scp: true,
  sftp: true,
  rsync: true,
  nc: true,
  ncat: true,
  telnet: true,
  dig: true,
  nslookup: true,
  host: true,
  ping: true,
  traceroute: true,
  mtr: true,
};

/** 源与目标都可能带 `user@host:` 前缀的命令：只有形如远端地址的参数才是网络目标 */
const TRANSFER_COMMANDS: Record<string, true> = { scp: true, sftp: true, rsync: true };

/** 目标写死在程序里、命令行看不出域名的命令 */
const FIXED_HOSTS: Record<string, string> = { gh: "github.com" };

/** `user@host:path`、`host:path`、`host:port` */
const REMOTE_ARG = /^(?:[^@/\s]+@)?[A-Za-z0-9._-]+:/;

const GUI_COMMANDS: Record<string, true> = { open: true, osascript: true, "xdg-open": true };

/** 包管理器只在安装类子命令上联网：映射到对应注册表域名，声明了才放行 */
const REGISTRIES: Array<{ commands: readonly string[]; subs: readonly string[]; domain: string }> = [
  {
    commands: ["npm", "pnpm", "yarn", "bun"],
    subs: ["install", "i", "ci", "add", "update", "upgrade", "exec", "create"],
    domain: "registry.npmjs.org",
  },
  { commands: ["pip", "pip3", "uv"], subs: ["install", "download", "sync", "add"], domain: "pypi.org" },
  { commands: ["cargo"], subs: ["install", "add", "fetch"], domain: "crates.io" },
  { commands: ["go"], subs: ["get", "install", "download"], domain: "proxy.golang.org" },
];

/** 直接执行远端包，没有子命令可判 */
const REMOTE_RUNNERS: Record<string, string> = { npx: "registry.npmjs.org", bunx: "registry.npmjs.org" };

const GIT_NETWORK: Record<string, true> = { fetch: true, pull: true, "ls-remote": true, submodule: true };

function checkRegistry(head: string, args: string[], domains: readonly string[]): string | null {
  const runner = REMOTE_RUNNERS[head];
  const registry = REGISTRIES.find((r) => r.commands.includes(head));
  const sub = (args.find((a) => !a.startsWith("-")) ?? "").toLowerCase();
  if (!runner && !registry) return null;
  if (registry && !registry.subs.includes(sub)) return null;
  const override = args.find((a) => a.startsWith("--registry="));
  const required = runner ?? registry?.domain ?? "";
  const domain = override ? (hostOf(override.slice("--registry=".length)) ?? required) : required;
  if (!hostAllowed(domain, domains)) {
    return `禁止 ${head} ${sub || "（执行远端包）"}：需要放行域名 ${domain}`;
  }
  return null;
}

/** 联网命令的目标主机：能判定的都判定，一个都不在 domains 内即拒绝 */
function checkNetwork(head: string, args: string[], domains: readonly string[]): string | null {
  const fixed = FIXED_HOSTS[head];
  if (fixed) {
    // 目标写死在程序里：只校验固定域名，其余参数是子命令
    return hostAllowed(fixed, domains) ? null : `禁止 ${head}：需要放行域名 ${fixed}`;
  }
  const targets: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") || arg.startsWith("+")) continue;
    if (arg.includes("://") || REMOTE_ARG.test(arg)) {
      const host = hostOf(arg);
      if (host) targets.push(host);
      continue;
    }
    if (URL_COMMANDS[head]) {
      // curl/wget：只有看起来像目标地址的词才算，`-X POST` 这类选项值跳过
      if (!URLISH.test(arg) && !HOSTISH.test(arg)) continue;
      const host = hostOf(arg);
      if (host) targets.push(host);
      continue;
    }
    if (!TRANSFER_COMMANDS[head]) {
      targets.push(hostOf(arg) ?? arg);
      break;
    }
  }
  for (const host of targets) {
    if (!hostAllowed(host, domains)) return `禁止访问域名 ${host}：未在 capabilities.domains 放行`;
  }
  return null;
}

function checkGitNetwork(sub: string, args: string[], policy: GuardPolicy): string | null {
  const domains = policy.domains ?? [];
  if (GIT_NETWORK[sub] || (sub === "remote" && args[0] === "update")) {
    return `禁止 git ${sub === "remote" ? "remote update" : sub}：远端来自仓库配置，命令里无法判定目标；联网请显式写 URL`;
  }
  if (sub !== "clone") return null;
  const source = args.find((a) => !a.startsWith("-"));
  if (!source) return "禁止 git clone：目标无法判定";
  if (source.startsWith("~")) return "禁止 git clone：路径含 ~，无法校验";
  if (source.startsWith("/") || source.startsWith(".")) {
    const hit = outsideReadable(source, policy);
    return hit ? `git clone ${hit}` : null;
  }
  const host = hostOf(source);
  if (!host) return "禁止 git clone：目标无法判定";
  return hostAllowed(host, domains) ? null : `禁止访问域名 ${host}：未在 capabilities.domains 放行`;
}

function checkGit(args: string[], policy: GuardPolicy): string | null {
  const { sub, args: rest, reason } = parseGit(args, policy);
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
      return checkGitNetwork(sub, rest, policy);
  }
}

/** 只读文件的命令：参数里的路径按可读目录校验 */
const READ_PATH_COMMANDS: Record<string, true> = {
  cat: true,
  head: true,
  tail: true,
  less: true,
  more: true,
  wc: true,
  grep: true,
  rg: true,
  awk: true,
  ls: true,
  stat: true,
  file: true,
  diff: true,
  cmp: true,
  find: true,
  du: true,
  md5: true,
  md5sum: true,
  shasum: true,
  sha256sum: true,
  cut: true,
  sort: true,
  uniq: true,
  tr: true,
  jq: true,
  tree: true,
  cd: true,
  pushd: true,
};

/** 写文件的命令：参数里的路径按可写目录校验（写包含读） */
const WRITE_PATH_COMMANDS: Record<string, true> = {
  cp: true,
  mv: true,
  rm: true,
  rmdir: true,
  mkdir: true,
  touch: true,
  tee: true,
  ln: true,
  chmod: true,
  chown: true,
  dd: true,
  truncate: true,
  sed: true,
  tar: true,
  unzip: true,
  zip: true,
  gzip: true,
  gunzip: true,
  install: true,
  patch: true,
  scp: true,
  sftp: true,
  rsync: true,
};

/** `--out=/path` 取 = 之后；`@/path` 是 curl 读文件写法 */
function pathArg(arg: string): string {
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  if (eq > 0) return arg.slice(eq + 1);
  return arg.startsWith("@") ? arg.slice(1) : arg;
}

function checkPaths(head: string, args: string[], policy: GuardPolicy): string | null {
  const writable = WRITE_PATH_COMMANDS[head] === true;
  if (!writable && READ_PATH_COMMANDS[head] !== true) return null;
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    const hit = writable ? outsideWritable(pathArg(arg), policy) : outsideReadable(pathArg(arg), policy);
    if (hit) return hit;
  }
  return null;
}

/** `> /abs`、`2>/abs`、`< /abs`：重定向目标按可写/可读校验 */
function checkRedirects(tokens: string[], policy: GuardPolicy): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    // `>/abs`、`2>/abs`；以及 `x>/abs` 这种无空格写法（前缀不含路径与选项字符）
    const match = /^(\d*)(>>?|<)(.*)$/.exec(token) ?? /^[^<>/=\s-]*(>>?|<)(.*)$/.exec(token);
    if (!match) continue;
    const op = match[2];
    const inline = match[3] ?? "";
    const target = inline || (tokens[i + 1] ?? "");
    if (!target || target.startsWith("&")) continue;
    const hit = op === ">" ? outsideWritable(target, policy) : outsideReadable(target, policy);
    if (hit) return hit;
  }
  return null;
}

const WRAPPERS: Record<string, true> = {
  command: true,
  exec: true,
  env: true,
  nohup: true,
  nice: true,
  time: true,
};

function checkSegment(tokens: string[], policy: GuardPolicy, depth: number): string | null {
  let at = 0;
  while (
    at < tokens.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[at]!) || WRAPPERS[tokens[at]!])
  ) {
    at++;
  }
  const rest = tokens.slice(at);
  const head = rest[0] ?? "";
  const args = rest.slice(1);
  const name = head.slice(head.lastIndexOf("/") + 1);

  // 条目写一个词（命令名）或前几个词（`bun publish`）都能命中
  const denyHit = (policy.blockedCommands ?? []).find((cmd) => {
    const words = cmd.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return false;
    const first = words[0]!;
    return (first === head || first === name) && words.slice(1).every((word, i) => word === args[i]);
  });
  if (denyHit) return `禁止命令 ${denyHit}：capabilities.blockedCommands`;
  if (name === "sudo") return "禁止 sudo";
  if (name === "rm" && rest.some((t) => t === "/" || t.startsWith("/*"))) {
    return "禁止删除根目录";
  }
  if (
    (name === "chmod" || name === "chown") &&
    rest.some((t) => t === "/etc" || t.startsWith("/etc/"))
  ) {
    return `禁止 ${name} /etc`;
  }
  if (GUI_COMMANDS[name] && !policy.gui) {
    return `禁止 ${name}：GUI 未开启（capabilities.gui）`;
  }
  if (name === "git") {
    const hit = checkGit(args, policy);
    if (hit) return hit;
  }
  if (HOST_COMMANDS[name] || URL_COMMANDS[name] || FIXED_HOSTS[name]) {
    const hit = checkNetwork(name, args, policy.domains ?? []);
    if (hit) return hit;
  }
  const registry = checkRegistry(name, args, policy.domains ?? []);
  if (registry) return registry;
  const pathHit = checkPaths(name, args, policy) ?? checkRedirects(tokens, policy);
  if (pathHit) return pathHit;

  // `bash -c "git push"`、`$(...)`、反引号：含空格的词当命令再判一次
  if (depth < 2) {
    for (const tok of tokens) {
      if (!/\s/.test(tok)) continue;
      const hit = scan(tok, policy, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function scan(cmd: string, policy: GuardPolicy, depth: number): string | null {
  for (const seg of segments(cmd)) {
    const hit = checkSegment(seg, policy, depth);
    if (hit) return hit;
  }
  return null;
}

/** 命中返回原因，放行返回 null。策略决定可读写目录、可访问域名、GUI 与额外禁止命令 */
export function blockBash(cmd: string, policy: GuardPolicy): string | null {
  return scan(cmd, policy, 0);
}
