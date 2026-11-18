// Worker 边界判定：纯函数，不执行 git、不读文件系统、不注册扩展。
// pisa-worker.ts 只负责事件接线；测试直接 import 本模块。

import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * 守卫关心的能力子集：由 src/capabilities.ts 生成清单、经 PISA_CAPABILITIES 传入。
 * 缺少清单时读取方必须按默认拒绝构造，见 parseCapabilities 的用法。
 */
export interface GuardCapabilities {
  read: string[];
  write: string[];
  /** 允许出网的域名；空表示禁止 curl/wget */
  domains: string[];
  /** 是否允许 GUI 命令与工具 */
  gui: boolean;
  /** 追加禁止的命令名（首段精确匹配） */
  blocked: string[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** 解析清单；缺失或损坏返回 null，由调用方决定默认值 */
export function parseCapabilities(raw: string | undefined): GuardCapabilities | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      read: strings(obj.read),
      write: strings(obj.write),
      domains: strings(obj.domains),
      gui: obj.gui === true,
      blocked: strings(obj.blocked),
    };
  } catch {
    return null;
  }
}

/** 写类工具按名字识别；读类工具用 read 根目录 */
export function isWriteTool(name: string): boolean {
  return /write|edit|patch|create|delete|remove|move|rename|mkdir/i.test(name);
}

/** 需要 GUI 的工具（浏览器自动化、截图、桌面操作） */
export function isGuiTool(name: string): boolean {
  return /computer|screenshot|browser|playwright|puppeteer|chrome-devtools|pencil/i.test(name);
}

/**
 * path 解析后不在任一允许根目录内时返回原因，否则 null。
 * roots 为空时只允许 workdir，与 012 的边界一致。
 */
export function outsideAllowed(p: string, workdir: string, roots: readonly string[] = []): string | null {
  if (!workdir) return `工作目录未知，无法校验路径：${p}`;
  const root = resolve(workdir);
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const bases = roots.length > 0 ? roots.map((r) => resolve(r)) : [root];
  for (const base of bases) {
    const rel = relative(base, abs);
    if (rel === "" || rel === ".") return null;
    if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) return null;
  }
  return roots.length > 0 ? `路径超出能力范围：${p}` : `路径在工作目录之外：${p}`;
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
    const hit = outsideAllowed(value, workdir);
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

/** 需要桌面会话的命令：gui=false 时拒绝 */
const GUI_COMMANDS: Record<string, true> = {
  open: true,
  "xdg-open": true,
  osascript: true,
  screencapture: true,
  xdotool: true,
  wmctrl: true,
};

/** 出网命令：目标域名必须在 domains 内 */
const NETWORK_COMMANDS: Record<string, true> = { curl: true, wget: true };

const URL_HOST = /[a-z][a-z0-9+.-]*:\/\/([^/?#\s"']+)/i;

/** 精确匹配或子域匹配；`*.example.com` 与 `example.com` 等价 */
function hostAllowed(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return domains.some((d) => {
    const base = d.trim().toLowerCase().replace(/^\*\./, "");
    return base !== "" && (h === base || h.endsWith(`.${base}`));
  });
}

function checkCapability(head: string, args: readonly string[], caps: GuardCapabilities): string | null {
  if (caps.blocked.includes(head)) return `能力清单禁止命令：${head}`;
  if (!caps.gui && GUI_COMMANDS[head]) return `未开启 GUI 能力：${head}`;
  if (!NETWORK_COMMANDS[head]) return null;
  const hosts = args.map((t) => URL_HOST.exec(t)?.[1]).filter((h): h is string => Boolean(h));
  if (hosts.length === 0) return `无法核对 ${head} 的目标域名`;
  const denied = hosts.find((h) => !hostAllowed(h, caps.domains));
  return denied === undefined ? null : `域名不在能力清单：${denied}`;
}

function checkSegment(
  tokens: string[],
  workdir: string,
  depth: number,
  caps?: GuardCapabilities | null,
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
    const hit = checkGit(args, workdir);
    if (hit) return hit;
  }
  if (caps) {
    const hit = checkCapability(head, args, caps);
    if (hit) return hit;
  }

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

function scan(cmd: string, workdir: string, depth: number, caps?: GuardCapabilities | null): string | null {
  for (const seg of segments(cmd)) {
    const hit = checkSegment(seg, workdir, depth, caps);
    if (hit) return hit;
  }
  return null;
}

/**
 * 命中返回原因，放行返回 null。workdir 用于判定 `-C` / `--work-tree` / `--git-dir` 越界。
 * caps 缺省时不施加能力约束，只保留内置 denylist 与工作目录边界。
 */
export function blockBash(
  cmd: string,
  workdir: string,
  caps?: GuardCapabilities | null,
): string | null {
  return scan(cmd, workdir, 0, caps);
}
