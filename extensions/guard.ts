// Worker 边界判定：纯函数，不执行 git、不读文件系统、不注册扩展。
// pisa-worker.ts 只负责事件接线；测试直接 import 本模块。

import { isAbsolute, relative, resolve, sep } from "node:path";

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

function checkSegment(tokens: string[], workdir: string, depth: number): string | null {
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

  // `bash -c "git push"`、`$(...)`、反引号：含空格的词当命令再判一次
  if (depth < 2) {
    for (const tok of tokens) {
      if (!/\s/.test(tok)) continue;
      const hit = scan(tok, workdir, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function scan(cmd: string, workdir: string, depth: number): string | null {
  for (const seg of segments(cmd)) {
    const hit = checkSegment(seg, workdir, depth);
    if (hit) return hit;
  }
  return null;
}

/** 命中返回原因，放行返回 null。workdir 用于判定 `-C` / `--work-tree` / `--git-dir` 越界 */
export function blockBash(cmd: string, workdir: string): string | null {
  return scan(cmd, workdir, 0);
}
