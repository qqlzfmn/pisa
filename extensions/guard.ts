// Worker 边界判定：纯函数，不执行 git、不读文件系统、不注册扩展。
// pisa-worker.ts 只负责事件接线；测试直接 import 本模块。

import { resolve } from "node:path";
import {
  defaultRuntime,
  hostAllowed,
  outsideRoots,
  type RuntimeCapabilities,
} from "../src/capabilities";

/** path 解析后落在 workdir 之外时返回原因，否则 null */
export function outsideWorkdir(p: string, workdir: string): string | null {
  if (!workdir) return `工作目录未知，无法校验路径：${p}`;
  return outsideRoots(p, [resolve(workdir)], resolve(workdir));
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
    if (ch === "|" && word.endsWith(">")) {
      word += ch; // `>|` 是覆写重定向，不能当管道切开
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

/** git 全局选项中带值的项；`-C` 还能把仓库指到可写目录之外 */
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
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

interface GitCommand {
  sub: string;
  args: string[];
  reason: string | null;
}

/** 剥离全局选项，返回子命令与剩余参数；路径型全局选项越界时 reason 非空 */
function parseGit(args: string[], caps: RuntimeCapabilities): GitCommand {
  let reason: string | null = null;
  const outside = (opt: string, value: string) => {
    const hit = outsideRoots(value, caps.write, caps.workdir);
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

function urlParts(token: string): { host: string; file: string | null } | null {
  if (!URL_PATTERN.test(token)) return null;
  try {
    const url = new URL(token);
    if (url.protocol === "file:") return { host: "", file: decodeURIComponent(url.pathname) };
    return { host: url.hostname, file: null };
  } catch {
    return null;
  }
}

/** `user@host:path` 形态的远端地址；本地路径返回 null */
function scpHost(token: string): string | null {
  if (URL_PATTERN.test(token)) return null;
  if (/^[./~]/.test(token) || token.startsWith("-")) return null;
  const match = /^(?:[^@\s/]+@)?([^:\s/]+):/.exec(token);
  return match?.[1] ?? null;
}

function stripUser(token: string): string {
  const at = token.lastIndexOf("@");
  return (at >= 0 ? token.slice(at + 1) : token).split("/")[0] ?? "";
}

function domainReason(host: string, caps: RuntimeCapabilities): string | null {
  if (!host) return null;
  return hostAllowed(host, caps.domains) ? null : `禁止访问未声明的域名：${host}`;
}

function checkRemoteToken(token: string, caps: RuntimeCapabilities): string | null {
  const parts = urlParts(token);
  if (parts) {
    if (parts.file) {
      const hit = outsideRoots(parts.file, caps.read, caps.workdir);
      return hit ? `禁止读取目录之外：${parts.file}` : null;
    }
    return domainReason(parts.host, caps);
  }
  const host = scpHost(token);
  return host ? domainReason(host, caps) : null;
}

function checkGit(args: string[], caps: RuntimeCapabilities): string | null {
  const { sub, args: rest, reason } = parseGit(args, caps);
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
    case "clone":
    case "submodule": {
      if (sub === "submodule" && rest[0] !== "add") return null;
      for (const token of rest) {
        const hit = checkRemoteToken(token, caps);
        if (hit) return hit;
      }
      return null;
    }
    case "fetch":
    case "pull": {
      for (const token of rest) {
        if (!URL_PATTERN.test(token) && !scpHost(token)) continue;
        const hit = checkRemoteToken(token, caps);
        if (hit) return hit;
      }
      return null;
    }
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

const NETWORK_HEADS: Record<string, true> = {
  "curl": true,
  "wget": true,
  "http": true,
  "https": true,
  "ssh": true,
  "scp": true,
  "sftp": true,
  "rsync": true,
  "nc": true,
  "netcat": true,
  "telnet": true,
  "gh": true,
};

const COPY_HEADS: Record<string, true> = {
  "cp": true,
  "install": true,
};
const WRITE_HEADS: Record<string, true> = {
  "cp": true,
  "install": true,
  "mv": true,
  "rm": true,
  "rmdir": true,
  "mkdir": true,
  "touch": true,
  "tee": true,
  "ln": true,
  "truncate": true,
  "chmod": true,
  "chown": true,
  "dd": true,
};
const READ_HEADS: Record<string, true> = {
  "cat": true,
  "head": true,
  "tail": true,
  "less": true,
  "more": true,
  "stat": true,
  "ls": true,
  "find": true,
  "du": true,
  "file": true,
  "wc": true,
  "cmp": true,
  "diff": true,
};
const GUI_HEADS: Record<string, true> = {
  "open": true,
  "xdg-open": true,
  "osascript": true,
  "screencapture": true,
  "cliclick": true,
  "xdotool": true,
  "wmctrl": true,
};

/** 联网命令中带值的选项，避免把选项值当作主机 */
const VALUE_OPTS: Record<string, true> = {
  "-p": true,
  "-P": true,
  "-i": true,
  "-l": true,
  "-o": true,
  "-F": true,
  "-J": true,
  "-L": true,
  "-R": true,
  "-D": true,
  "-W": true,
  "-w": true,
  "-b": true,
  "-c": true,
  "-e": true,
  "-m": true,
  "-s": true,
  "-t": true,
  "-u": true,
  "-A": true,
  "-X": true,
  "-H": true,
  "-d": true,
  "-T": true,
  "-E": true,
  "-I": true,
  "-K": true,
  "-Q": true,
  "-S": true,
  "-y": true,
  "-Y": true,
  "-a": true,
  "--auth": true,
  "--proxy": true,
  "--timeout": true,
  "--header": true,
  "--user": true,
  "--password": true,
  "--port": true,
};

const CURL_VALUE_OPTS: Record<string, true> = {
  "-o": true,
  "--output": true,
  "-H": true,
  "--header": true,
  "-d": true,
  "--data": true,
  "--data-raw": true,
  "--data-binary": true,
  "-X": true,
  "--request": true,
  "-u": true,
  "--user": true,
  "-A": true,
  "--user-agent": true,
  "-e": true,
  "--referer": true,
  "-b": true,
  "--cookie": true,
  "-c": true,
  "--cookie-jar": true,
  "-T": true,
  "--upload-file": true,
  "-w": true,
  "--write-out": true,
};

function checkNetwork(head: string, args: string[], caps: RuntimeCapabilities): string | null {
  const hosts: string[] = [];
  const reads: string[] = [];
  const writes: string[] = [];

  if (head === "gh") {
    let host = "github.com";
    for (let i = 0; i < args.length; i++) {
      const token = args[i]!;
      if (token === "--hostname" || token === "--host") {
        const value = args[i + 1];
        if (value) host = value;
        i++;
      } else if (token.startsWith("--hostname=")) {
        host = token.slice("--hostname=".length);
      } else if (token.startsWith("--host=")) {
        host = token.slice("--host=".length);
      }
    }
    hosts.push(host);
  } else if (head === "curl" || head === "wget") {
    for (let i = 0; i < args.length; i++) {
      const token = args[i]!;
      if (token === "--") continue;
      if (token === "-o" || token === "--output" || (head === "wget" && token === "-O")) {
        const value = args[i + 1];
        if (value) writes.push(value);
        i++;
        continue;
      }
      if (token.startsWith("--output=")) {
        writes.push(token.slice("--output=".length));
        continue;
      }
      if (token.startsWith("--output-document=")) {
        writes.push(token.slice("--output-document=".length));
        continue;
      }
      if (token === "-T" || token === "--upload-file") {
        const value = args[i + 1];
        if (value) reads.push(value);
        i++;
        continue;
      }
      if (token === "-d" || token === "--data" || token === "--data-raw" || token === "--data-binary") {
        const value = args[i + 1];
        if (value?.startsWith("@")) reads.push(value.slice(1));
        i++;
        continue;
      }
      if (CURL_VALUE_OPTS[token]) {
        i++;
        continue;
      }
      if (token.startsWith("-")) continue;

      const parts = urlParts(token);
      if (parts) {
        if (parts.file) reads.push(parts.file);
        else if (parts.host) hosts.push(parts.host);
      }
    }
  } else {
    const localBefore: string[] = [];
    const localAfter: string[] = [];
    let seenRemote = false;
    for (let i = 0; i < args.length; i++) {
      const token = args[i]!;
      if (token === "--") continue;
      if (token.startsWith("-")) {
        if (VALUE_OPTS[token]) i++;
        continue;
      }

      const parts = urlParts(token);
      if (parts) {
        if (parts.file) reads.push(parts.file);
        else if (parts.host) hosts.push(parts.host);
        seenRemote = true;
        continue;
      }
      const remote = scpHost(token);
      if (remote) {
        hosts.push(remote);
        seenRemote = true;
        continue;
      }
      if (head === "scp" || head === "rsync") {
        (seenRemote ? localAfter : localBefore).push(token);
        continue;
      }
      if (hosts.length === 0) hosts.push(stripUser(token));
    }
    if (head === "scp" || head === "rsync") {
      if (seenRemote) {
        reads.push(...localBefore);
        writes.push(...localAfter);
      } else if (localBefore.length > 1) {
        reads.push(...localBefore.slice(0, -1));
        writes.push(localBefore.at(-1)!);
      } else {
        writes.push(...localBefore);
      }
    }
  }

  for (const host of hosts) {
    const hit = domainReason(host, caps);
    if (hit) return hit;
  }
  for (const path of reads) {
    const hit = outsideRoots(path, caps.read, caps.workdir);
    if (hit) return `禁止读取目录之外：${path}`;
  }
  for (const path of writes) {
    const hit = outsideRoots(path, caps.write, caps.workdir);
    if (hit) return `禁止写入目录之外：${path}`;
  }
  return null;
}

function checkDeny(tokens: string[], deny: string[]): string | null {
  for (const entry of deny) {
    const parts = entry.split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    if (parts.every((part, index) => tokens[index] === part)) return `禁止命令：${entry}`;
  }
  return null;
}

function checkRedirects(tokens: string[], caps: RuntimeCapabilities): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(\d*)(&>>?|>>?)(.*)$/.exec(tokens[i]!);
    if (!match) continue;
    const target = (match[3] || tokens[i + 1] || "").replace(/^\|/, "");
    if (!target || target.startsWith("&") || target === "|") continue;
    const hit = outsideRoots(target, caps.write, caps.workdir);
    if (hit) return `禁止写入目录之外：${target}`;
  }
  return null;
}

function pathArgs(args: string[]): string[] {
  const out: string[] = [];
  let positional = false;
  for (const token of args) {
    if (token === "--") {
      positional = true;
      continue;
    }
    if (!positional && (token === "" || token.startsWith("-"))) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    out.push(token);
  }
  return out;
}

function checkWritePaths(head: string, args: string[], caps: RuntimeCapabilities): string | null {
  if (head === "dd") {
    for (const token of args) {
      if (token.startsWith("if=")) {
        const path = token.slice(3);
        const hit = outsideRoots(path, caps.read, caps.workdir);
        if (hit) return `禁止读取目录之外：${path}`;
      } else if (token.startsWith("of=")) {
        const path = token.slice(3);
        const hit = outsideRoots(path, caps.write, caps.workdir);
        if (hit) return `禁止写入目录之外：${path}`;
      }
    }
    return null;
  }

  const paths = pathArgs(args);
  let sources: string[] = [];
  let targets: string[] = [];

  if (COPY_HEADS[head]) {
    const specified: string[] = [];
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const token = args[i]!;
      if (token === "-t" || token === "--target-directory") {
        const value = args[i + 1];
        if (value) specified.push(value);
        i++;
      } else if (token.startsWith("--target-directory=")) {
        specified.push(token.slice("--target-directory=".length));
      } else {
        rest.push(token);
      }
    }
    const restPaths = pathArgs(rest);
    if (specified.length > 0) {
      targets = specified;
      sources = restPaths;
    } else {
      targets = restPaths.slice(-1);
      sources = restPaths.slice(0, -1);
    }
  } else if (head === "ln") {
    targets = paths.slice(-1);
    sources = paths.slice(0, -1);
  } else {
    targets = paths;
  }

  for (const path of sources) {
    const hit = outsideRoots(path, caps.read, caps.workdir);
    if (hit) return `禁止读取目录之外：${path}`;
  }
  for (const path of targets) {
    const hit = outsideRoots(path, caps.write, caps.workdir);
    if (hit) return `禁止写入目录之外：${path}`;
  }
  return null;
}

function checkReadPaths(args: string[], caps: RuntimeCapabilities): string | null {
  for (const path of pathArgs(args)) {
    const hit = outsideRoots(path, caps.read, caps.workdir);
    if (hit) return `禁止读取目录之外：${path}`;
  }
  return null;
}

function checkSegment(tokens: string[], caps: RuntimeCapabilities, depth: number): string | null {
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
  const denied = checkDeny(rest, caps.deny);
  if (denied) return denied;
  if (head === "git") {
    const hit = checkGit(args, caps);
    if (hit) return hit;
  }
  if (GUI_HEADS[head] && !caps.gui) {
    return `禁止 GUI 操作：${head}（任务未开启 gui）`;
  }
  if (NETWORK_HEADS[head]) {
    const hit = checkNetwork(head, args, caps);
    if (hit) return hit;
  }
  const redirect = checkRedirects(tokens, caps);
  if (redirect) return redirect;
  if (WRITE_HEADS[head]) {
    const hit = checkWritePaths(head, args, caps);
    if (hit) return hit;
  }
  if (READ_HEADS[head]) {
    const hit = checkReadPaths(args, caps);
    if (hit) return hit;
  }

  // `bash -c "git push"`、`$(...)`、反引号：含空格的词当命令再判一次
  if (depth < 2) {
    for (const tok of tokens) {
      if (!/\s/.test(tok)) continue;
      const hit = scan(tok, caps, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function scan(cmd: string, caps: RuntimeCapabilities, depth: number): string | null {
  for (const seg of segments(cmd)) {
    const hit = checkSegment(seg, caps, depth);
    if (hit) return hit;
  }
  return null;
}

/** 命中返回原因，放行返回 null。caps 缺省为默认拒绝：只能读写 workdir，不联网，不开 GUI */
export function blockBash(
  cmd: string,
  workdir: string,
  caps: RuntimeCapabilities = defaultRuntime(workdir),
): string | null {
  return scan(cmd, caps, 0);
}
