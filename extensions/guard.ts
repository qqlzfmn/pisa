// Worker 边界判定：纯函数，不执行 git、不读文件系统、不注册扩展。
// pisa-worker.ts 只负责事件接线；测试直接 import 本模块。

import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** 任务能力清单里与 guard 相关的部分 */
export interface GuardCapabilities {
  readDirs: string[];
  writeDirs: string[];
  domains: string[];
  gui: boolean;
  blocked: string[];
}

/** 启动日志展示的内置拒绝项：与下面的判定逻辑一一对应 */
export const BUILTIN_BLOCKED: readonly string[] = [
  "git push / rebase / reset --hard / clean -f",
  "git checkout|switch 分支 / worktree remove|prune / branch -D|-d / commit --amend",
  "git -C / --work-tree / --git-dir 越界",
  "sudo",
  "rm -rf /",
  "chmod|chown /etc",
  "读取路径越界",
  "写入目标越界",
  "域名未放行",
  "GUI 未放行",
  "能力配置额外拒绝的命令",
];

function inside(abs: string, root: string): boolean {
  const rel = relative(resolve(root), abs);
  return rel === "" || rel === "." || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function expand(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function absolute(p: string, workdir: string): string {
  const value = expand(p);
  return isAbsolute(value) ? resolve(value) : resolve(workdir, value);
}

/** path 解析后落在 workdir 之外时返回原因，否则 null */
export function outsideWorkdir(p: string, workdir: string): string | null {
  if (!workdir) return `工作目录未知，无法校验路径：${p}`;
  return inside(absolute(p, workdir), workdir) ? null : `路径在工作目录之外：${p}`;
}

/** path 不在任一允许目录内时返回原因；未知工作目录一律拒绝 */
export function outsidePath(p: string, workdir: string, dirs: readonly string[]): string | null {
  if (!workdir) return `工作目录未知，无法校验路径：${p}`;
  const abs = absolute(p, workdir);
  return dirs.some((dir) => inside(abs, dir)) ? null : `路径不在允许目录内：${p}`;
}

/** 默认能力：只有工作目录与系统临时目录，网络与 GUI 关闭 */
function defaultCapabilities(workdir: string): GuardCapabilities {
  const tmp = resolve(tmpdir());
  const root = workdir ? resolve(workdir) : tmp;
  return { readDirs: [root, tmp, "/tmp"], writeDirs: [root, tmp, "/tmp"], domains: [], gui: false, blocked: [] };
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

/** 会发起网络的 git 子命令；只有显式 URL/主机名才做域名校验，远端别名不在文本可判范围 */
const GIT_NET_SUBS: Record<string, true> = {
  clone: true,
  fetch: true,
  pull: true,
  "ls-remote": true,
  submodule: true,
};

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

function checkGit(args: string[], workdir: string, caps: GuardCapabilities): string | null {
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
  }

  if (GIT_NET_SUBS[sub]) {
    for (const tok of rest) {
      const host = hostOfToken(tok);
      if (host && !caps.domains.includes(host)) return `域名未放行：${host}`;
    }
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

const WRITE_ALL: Record<string, true> = {
  rm: true,
  rmdir: true,
  mkdir: true,
  touch: true,
  chmod: true,
  chown: true,
  truncate: true,
  tee: true,
  shred: true,
};

/** 最后一个非选项参数是写入目标，前面的参数是读取来源 */
const WRITE_DEST: Record<string, true> = {
  cp: true,
  mv: true,
  ln: true,
  install: true,
  rsync: true,
};

const READ_COMMANDS: Record<string, true> = {
  cat: true,
  head: true,
  tail: true,
  less: true,
  more: true,
  grep: true,
  rg: true,
  ls: true,
  find: true,
  sed: true,
  awk: true,
  wc: true,
  diff: true,
  stat: true,
  readlink: true,
  realpath: true,
  du: true,
  sort: true,
  uniq: true,
  tar: true,
  unzip: true,
  file: true,
  strings: true,
  xxd: true,
  od: true,
};

const NET_COMMANDS: Record<string, true> = {
  curl: true,
  wget: true,
  nc: true,
  netcat: true,
  telnet: true,
  ssh: true,
  scp: true,
  sftp: true,
  ping: true,
  dig: true,
  nslookup: true,
};

/** 这些参数带值，值是文件/头/数据而不是主机 */
const NET_VALUE_FLAGS: Record<string, true> = {
  "-o": true,
  "--output": true,
  "-H": true,
  "--header": true,
  "-d": true,
  "--data": true,
  "--data-binary": true,
  "-X": true,
  "--request": true,
  "-u": true,
  "--user": true,
  "-A": true,
  "--user-agent": true,
  "-F": true,
  "--form": true,
  "-T": true,
  "--upload-file": true,
  "-e": true,
  "-i": true,
  "-l": true,
  "-p": true,
};

const GUI_COMMANDS: Record<string, true> = { open: true, osascript: true, "xdg-open": true };

/** 从 URL、user@host:path 或 host:port 里取主机名；本地路径与裸词返回 null */
function hostOfToken(tok: string): string | null {
  if (!tok || tok.startsWith("-") || /\s/.test(tok) || /^\d+$/.test(tok)) return null;
  if (tok.includes("://")) {
    try {
      return new URL(tok).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  }
  const at = tok.lastIndexOf("@");
  const bare = at >= 0 ? tok.slice(at + 1) : tok;
  if (at < 0 && (bare.startsWith("/") || bare.startsWith(".") || bare.includes("/"))) return null;
  const candidate = (bare.split("/")[0] ?? "").split(":")[0] ?? "";
  if (!candidate) return null;
  // 无 scheme、无 user@、无端口、无点号的裸词更像本地文件/参数
  if (at < 0 && !candidate.includes(".") && !bare.includes(":")) return null;
  return candidate.toLowerCase();
}

function checkNetwork(head: string, args: string[], caps: GuardCapabilities): string | null {
  const operands: string[] = [];
  let skip = false;
  for (const tok of args) {
    if (skip) {
      skip = false;
      continue;
    }
    if (tok.startsWith("-")) {
      if (NET_VALUE_FLAGS[tok]) skip = true;
      continue;
    }
    operands.push(tok);
  }
  const hosts = operands.map(hostOfToken).filter((host): host is string => Boolean(host));
  if (hosts.length === 0 && operands.length === 1) {
    // `ping localhost`、`ssh host` 这类裸主机名
    const host = (operands[0]!.split("/")[0] ?? "").split(":")[0]?.toLowerCase() ?? "";
    if (host) hosts.push(host);
  }
  if (hosts.length === 0) return `网络命令未放行：${head}`;
  const denied = hosts.find((host) => !caps.domains.includes(host));
  return denied ? `域名未放行：${denied}` : null;
}

function writeTarget(tok: string, workdir: string, caps: GuardCapabilities): string | null {
  if (tok === "/dev/null" || tok === "/dev/stdout" || tok === "/dev/stderr") return null;
  return outsidePath(tok, workdir, caps.writeDirs);
}

function checkRedirections(tokens: string[], workdir: string, caps: GuardCapabilities): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (/\s/.test(tok) || !tok.includes(">")) continue;
    if (/^\d*>&\d+$/.test(tok) || tok === ">&2") continue;
    if (tok === ">" || tok === ">>" || tok === "&>" || tok === "&>>") {
      const target = tokens[i + 1];
      if (!target) continue;
      const hit = writeTarget(target, workdir, caps);
      if (hit) return hit;
      continue;
    }
    const at = tok.indexOf(">");
    const target = tok.slice(at + 1).replace(/^>/, "").replace(/^\|/, "");
    if (!target) continue;
    const hit = writeTarget(target, workdir, caps);
    if (hit) return hit;
  }
  return null;
}

function checkCapabilities(
  head: string,
  args: string[],
  workdir: string,
  caps: GuardCapabilities,
): string | null {
  const words = [head, ...args];
  const custom = caps.blocked.find((rule) => {
    const parts = rule.split(/\s+/).filter(Boolean);
    return parts.length > 0 && parts.every((part, i) => words[i] === part);
  });
  if (custom) return `命令被能力配置拒绝：${custom}`;

  if (GUI_COMMANDS[head] && !caps.gui) return `图形界面未放行：${head}`;
  if (head === "cd" || head === "pushd") {
    const target = args.find((tok) => !tok.startsWith("-")) ?? "~";
    const hit = outsidePath(target, workdir, caps.readDirs);
    if (hit) return hit;
  }
  if (NET_COMMANDS[head]) {
    const hit = checkNetwork(head, args, caps);
    if (hit) return hit;
  }

  if (WRITE_ALL[head]) {
    for (const tok of args) {
      if (tok.startsWith("-")) continue;
      const hit = writeTarget(tok, workdir, caps);
      if (hit) return hit;
    }
  }

  if (WRITE_DEST[head]) {
    const operands = args.filter((tok) => !tok.startsWith("-"));
    const dest = operands.at(-1);
    if (dest) {
      const hit = writeTarget(dest, workdir, caps);
      if (hit) return hit;
    }
    for (const source of operands.slice(0, -1)) {
      const hit = outsidePath(source, workdir, caps.readDirs);
      if (hit) return hit;
    }
  }

  if (READ_COMMANDS[head]) {
    for (const tok of args) {
      if (tok.startsWith("-")) continue;
      const looksPath =
        isAbsolute(tok) || tok.startsWith("~") || tok === ".." || tok.startsWith("../");
      if (!looksPath) continue;
      const hit = outsidePath(tok, workdir, caps.readDirs);
      if (hit) return hit;
    }
  }
  return null;
}

function checkSegment(
  tokens: string[],
  workdir: string,
  depth: number,
  caps: GuardCapabilities,
): string | null {
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
    const hit = checkGit(args, workdir, caps);
    if (hit) return hit;
  }

  const redirect = checkRedirections(tokens, workdir, caps);
  if (redirect) return redirect;
  const capability = checkCapabilities(head, args, workdir, caps);
  if (capability) return capability;

  // `bash -c "git push"`、`$(...)`、反引号：含空格的词当命令再判一次
  if (depth < 2) {
    for (const tok of tokens) {
      if (!/\s/.test(tok)) continue;
      const hit = scan(tok, workdir, depth + 1, caps);
      if (hit) return hit;
    }
  }
  return null;
}

function scan(cmd: string, workdir: string, depth: number, caps: GuardCapabilities): string | null {
  for (const seg of segments(cmd)) {
    const hit = checkSegment(seg, workdir, depth, caps);
    if (hit) return hit;
  }
  return null;
}

/** 命中返回原因，放行返回 null。未传能力清单时按默认拒绝（工作目录 + 临时目录）。 */
export function blockBash(cmd: string, workdir: string, caps?: GuardCapabilities): string | null {
  return scan(cmd, workdir, 0, caps ?? defaultCapabilities(workdir));
}
