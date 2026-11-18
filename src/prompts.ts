import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 内置段落目录：与源码同仓，版本随仓库走 */
const BUILTIN_DIR = join(import.meta.dir, "..", "prompts");
const MANIFEST_FILE = "manifest.json";
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const SECTION_KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
/** 段落正文允许的占位符；写错在加载时拒绝，不等到 Worker 跑到一半 */
const VARIABLES: Record<string, true> = { taskId: true, prompt: true, context: true };

export type PromptSource = "builtin" | "team" | "repo";

export interface PromptSection {
  key: string;
  version: number;
  text: string;
  /** 文件绝对路径 */
  file: string;
}

export interface ResolvedPrompt extends PromptSection {
  source: PromptSource;
  /** 仓库覆盖时对应的别名 */
  repo?: string;
  /** 内置版本，用于对比与列表 */
  builtinVersion: number;
}

interface ParsedOverride {
  version: number;
  text: string;
  file: string;
}

export interface LoadPromptsOptions {
  /** 覆盖目录；未配置或不存在时只用内置段落 */
  dir?: string;
  /** 配置里的仓库别名；用于拒绝写错的 repos/<别名> 目录 */
  repos?: readonly string[];
  /** 内置目录；测试用 */
  builtinDir?: string;
}

function readManifest(path: string): { version: number; sections: Record<string, unknown> } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`提示词清单不是合法 JSON：${path}（${(err as Error).message}）`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error(`提示词清单必须是对象：${path}`);
  const { version, sections } = raw as { version?: unknown; sections?: unknown };
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) {
    throw new Error(`提示词清单的 version 必须是正整数：${path}`);
  }
  if (typeof sections !== "object" || sections === null || Array.isArray(sections)) {
    throw new Error(`提示词清单缺少 sections 对象：${path}`);
  }
  return { version, sections: sections as Record<string, unknown> };
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1] ?? "");
}

function checkVariables(key: string, file: string, text: string): void {
  for (const name of placeholders(text)) {
    if (!VARIABLES[name]) throw new Error(`提示词段落 ${key} 使用了未知占位符 {{${name}}}：${file}`);
  }
}

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) markdownFiles(path, out);
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

function parseOverride(key: string, file: string): ParsedOverride {
  const raw = readFileSync(file, "utf8");
  const match = FRONT_MATTER.exec(raw);
  if (!match) throw new Error(`提示词覆盖缺少头部（--- / version）：${file}`);
  let version: number | undefined;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const at = line.indexOf(":");
    if (at <= 0) throw new Error(`提示词覆盖头部格式错误：${file}：${line}`);
    const name = line.slice(0, at).trim();
    if (name !== "version") throw new Error(`提示词覆盖头部有未知键 ${name}：${file}`);
    version = Number(line.slice(at + 1).trim());
  }
  if (version === undefined || !Number.isInteger(version) || version <= 0) {
    throw new Error(`提示词覆盖的 version 必须是正整数：${file}`);
  }
  const text = raw.slice(match[0].length).replace(/^\s+|\s+$/g, "");
  if (!text) throw new Error(`提示词覆盖正文为空：${file}`);
  checkVariables(key, file, text);
  return { version, text, file };
}

function assertKnown(key: string, file: string, sections: Map<string, PromptSection>): void {
  if (!sections.has(key)) {
    throw new Error(`未知提示词段落 ${key}：${file}；可用：${[...sections.keys()].join(", ")}`);
  }
}

function loadBuiltin(dir: string): { version: number; sections: Map<string, PromptSection> } {
  const manifestPath = join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) throw new Error(`缺少提示词清单：${manifestPath}`);
  const { version, sections: rawSections } = readManifest(manifestPath);
  const sections = new Map<string, PromptSection>();
  const files = new Set<string>();
  for (const [key, sectionVersion] of Object.entries(rawSections)) {
    if (!SECTION_KEY.test(key)) throw new Error(`提示词段落键不合法：${key}（${manifestPath}）`);
    if (typeof sectionVersion !== "number" || !Number.isInteger(sectionVersion) || sectionVersion <= 0) {
      throw new Error(`提示词段落 ${key} 的 version 必须是正整数：${manifestPath}`);
    }
    const file = join(dir, key.split(".").join(sep) + ".md");
    files.add(file);
    if (!existsSync(file)) throw new Error(`提示词段落 ${key} 缺少文件：${file}`);
    const text = readFileSync(file, "utf8").replace(/^\s+|\s+$/g, "");
    if (!text) throw new Error(`提示词段落 ${key} 正文为空：${file}`);
    checkVariables(key, file, text);
    sections.set(key, { key, version: sectionVersion as number, text, file });
  }
  for (const file of markdownFiles(dir)) {
    if (!files.has(file)) throw new Error(`提示词段落未在清单登记：${file}`);
  }
  return { version, sections };
}

function loadOverrides(
  root: string,
  sections: Map<string, PromptSection>,
  repos: readonly string[],
): { team: Map<string, ParsedOverride>; repoOverrides: Map<string, Map<string, ParsedOverride>> } {
  const team = new Map<string, ParsedOverride>();
  const repoOverrides = new Map<string, Map<string, ParsedOverride>>();
  if (!existsSync(root)) return { team, repoOverrides };
  if (!statSync(root).isDirectory()) throw new Error(`提示词覆盖路径不是目录：${root}`);

  for (const name of readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const path = join(root, name);
    if (!statSync(path).isDirectory() && name.endsWith(".md")) {
      const key = name.slice(0, -3);
      assertKnown(key, path, sections);
      team.set(key, parseOverride(key, path));
      continue;
    }
    if (name === "repos" && statSync(path).isDirectory()) {
      for (const alias of readdirSync(path)) {
        if (alias.startsWith(".")) continue;
        const repoDir = join(path, alias);
        if (!statSync(repoDir).isDirectory()) throw new Error(`提示词仓库覆盖必须是目录：${repoDir}`);
        if (!repos.includes(alias)) {
          throw new Error(`提示词仓库覆盖目录 ${alias} 不在配置 repos 里：${repoDir}`);
        }
        const overrides = new Map<string, ParsedOverride>();
        for (const file of readdirSync(repoDir)) {
          if (file.startsWith(".")) continue;
          const filePath = join(repoDir, file);
          if (!file.endsWith(".md") || !statSync(filePath).isFile()) {
            throw new Error(`提示词仓库覆盖目录里有无法识别的条目：${filePath}（只接受 *.md）`);
          }
          const key = file.slice(0, -3);
          assertKnown(key, filePath, sections);
          overrides.set(key, parseOverride(key, filePath));
        }
        if (overrides.size) repoOverrides.set(alias, overrides);
      }
      continue;
    }
    throw new Error(`提示词覆盖目录里有无法识别的条目：${path}（只接受 *.md 与 repos/）`);
  }
  return { team, repoOverrides };
}

/** 内置段落的显示路径：项目内显示相对路径，避免日志里出现整条绝对路径 */
function displayPath(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") && !rel.startsWith(sep) ? rel : file;
}

function sourceLabel(prompt: ResolvedPrompt): string {
  if (prompt.source === "builtin") return `内置 v${prompt.version}`;
  if (prompt.source === "team") return `团队 v${prompt.version}`;
  return `仓库 ${prompt.repo ?? ""} v${prompt.version}`;
}

interface DiffOp {
  kind: " " | "-" | "+";
  line: string;
}

function diffOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: "-", line: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: "+", line: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ kind: "-", line: a[i++]! });
  while (j < b.length) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}

function unifiedDiff(a: readonly string[], b: readonly string[], from: string, to: string): string {
  if (a.join("\n") === b.join("\n")) return "（内容与内置一致）";
  const ops = diffOps(a, b);
  const out = [`--- ${from}`, `+++ ${to}`];
  let i = 0;
  let covered = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === " ") {
      i += 1;
      continue;
    }
    const start = Math.max(covered, i - 3);
    let last = i;
    let cursor = i;
    while (cursor < ops.length) {
      if (ops[cursor]!.kind !== " ") {
        last = cursor;
        cursor += 1;
        continue;
      }
      let run = cursor;
      while (run < ops.length && ops[run]!.kind === " ") run += 1;
      if (run < ops.length && run - cursor <= 6) {
        cursor = run;
        continue;
      }
      break;
    }
    const end = Math.min(ops.length, last + 4);
    const before = ops.slice(0, start);
    const hunk = ops.slice(start, end);
    const aStart = before.filter((op) => op.kind !== "+").length + 1;
    const bStart = before.filter((op) => op.kind !== "-").length + 1;
    const aCount = hunk.filter((op) => op.kind !== "+").length;
    const bCount = hunk.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of hunk) out.push(op.kind + op.line);
    i = end;
    covered = end;
  }
  return out.join("\n");
}

/**
 * 提示词库：内置段落 + 团队覆盖 + 仓库覆盖。
 * 加载时完成全部校验，运行期只做键查找与占位符替换。
 */
export class PromptLibrary {
  constructor(
    readonly version: number,
    private readonly sections: Map<string, PromptSection>,
    private readonly team: Map<string, ParsedOverride>,
    private readonly repos: Map<string, Map<string, ParsedOverride>>,
  ) {}

  keys(): string[] {
    return [...this.sections.keys()];
  }

  resolve(key: string, repo?: string): ResolvedPrompt {
    const base = this.sections.get(key);
    if (!base) throw new Error(`未知提示词段落：${key}；可用：${this.keys().join(", ")}`);
    const repoOverride = repo ? this.repos.get(repo)?.get(key) : undefined;
    if (repoOverride) {
      return {
        key,
        version: repoOverride.version,
        text: repoOverride.text,
        file: repoOverride.file,
        source: "repo",
        repo,
        builtinVersion: base.version,
      };
    }
    const teamOverride = this.team.get(key);
    if (teamOverride) {
      return {
        key,
        version: teamOverride.version,
        text: teamOverride.text,
        file: teamOverride.file,
        source: "team",
        builtinVersion: base.version,
      };
    }
    return { ...base, source: "builtin", builtinVersion: base.version };
  }

  render(key: string, vars: Record<string, string> = {}, repo?: string): string {
    return this.resolve(key, repo).text.replace(
      /\{\{([A-Za-z0-9_]+)\}\}/g,
      (_match, name: string) => vars[name] ?? "",
    );
  }

  describe(repo?: string, trigger = "/pisa"): string {
    const rows = this.keys().map((key) => this.resolve(key, repo));
    const overridden = rows.filter((row) => row.source !== "builtin").length;
    const scope = repo ? `仓库 ${repo}` : "团队";
    return [
      `提示词 v${this.version} · ${rows.length} 个段落 · 覆盖 ${overridden} 个（${scope}）`,
      ...rows.map((row) => `${row.key} · ${sourceLabel(row)} · ${displayPath(row.file)}`),
      "",
      `查看与内置版本的差异：${trigger} prompts diff [段落键]`,
    ].join("\n");
  }

  diff(repo?: string, key?: string): string {
    if (key && !this.sections.has(key)) {
      throw new Error(`未知提示词段落：${key}；可用：${this.keys().join(", ")}`);
    }
    const keys = key
      ? [key]
      : this.keys().filter((candidate) => this.resolve(candidate, repo).source !== "builtin");
    if (!keys.length) return `提示词 v${this.version}：没有覆盖，全部使用内置段落。`;
    return keys
      .map((candidate) => {
        const base = this.sections.get(candidate)!;
        const effective = this.resolve(candidate, repo);
        if (effective.source === "builtin") {
          return `${candidate}：没有覆盖，使用内置 v${base.version}。`;
        }
        return [
          `${candidate} · 内置 v${base.version} → ${sourceLabel(effective)}（${displayPath(effective.file)}）`,
          unifiedDiff(
            base.text.split("\n"),
            effective.text.split("\n"),
            `内置 v${base.version} ${displayPath(base.file)}`,
            `生效 v${effective.version} ${displayPath(effective.file)}`,
          ),
        ].join("\n");
      })
      .join("\n\n");
  }
}

export function loadPrompts(opts: LoadPromptsOptions = {}): PromptLibrary {
  const { version, sections } = loadBuiltin(opts.builtinDir ?? BUILTIN_DIR);
  if (!opts.dir) return new PromptLibrary(version, sections, new Map(), new Map());
  const { team, repoOverrides } = loadOverrides(opts.dir, sections, opts.repos ?? []);
  return new PromptLibrary(version, sections, team, repoOverrides);
}

let cached: PromptLibrary | undefined;

/** 生产与测试里的缺省库：只含内置段落，首次调用时加载 */
export function defaultPrompts(): PromptLibrary {
  cached ??= loadPrompts();
  return cached;
}
