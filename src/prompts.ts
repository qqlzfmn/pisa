import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./types";

/** 段落顺序即渲染顺序；内置文件必须提供全部段落 */
export const SECTION_KEYS = ["intro", "resume", "context", "task", "constraints"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export type LayerKind = "builtin" | "team" | "repo";

const SOURCE_LABEL: Record<LayerKind, string> = { builtin: "内置", team: "团队", repo: "仓库" };

/** 包内提示词目录；团队覆盖目录由配置的 prompts.dir 指定 */
export const DEFAULT_BUILTIN_DIR = join(import.meta.dir, "..", "prompts");

/** 仓库级覆盖文件名直接来自别名，限制字符集避免路径穿越 */
const SAFE_ALIAS = /^[A-Za-z0-9_-]+$/;

const FRONT_MATTER = /^---\n(?:([\s\S]*?)\n)?---\n?/;
const SECTION_MARK = /^<!--\s*section:\s*([A-Za-z0-9_-]+)\s*-->\s*$/;

export class PromptError extends Error {}

interface PromptLayer {
  kind: LayerKind;
  file: string;
  version: number;
  sections: Partial<Record<SectionKey, string>>;
}

export interface ResolvedSection {
  text: string;
  source: LayerKind;
  version: number;
  /** 内置原文与版本，`prompts diff` 用 */
  builtinText: string;
  builtinVersion: number;
}

export interface ResolvedPrompts {
  repo: string | null;
  builtinVersion: number;
  teamVersion: number | null;
  repoVersion: number | null;
  sections: Record<SectionKey, ResolvedSection>;
}

export interface PromptLibraryOptions {
  /** 包内提示词目录；测试可替换 */
  builtinDir?: string;
  /** 团队覆盖目录；null 表示只用内置 */
  teamDir?: string | null;
}

/** 读取一个提示词文件：front matter 只有 version，正文按段落标记切分 */
function parsePromptFile(file: string, kind: LayerKind, required: boolean): PromptLayer | null {
  if (!existsSync(file)) {
    if (required) throw new PromptError(`提示词文件缺失：${file}`);
    return null;
  }
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const head = FRONT_MATTER.exec(text);
  if (!head) throw new PromptError(`${file}：缺少 front matter（---\\nversion: N\\n---）`);

  let version: number | null = null;
  for (const raw of (head[1] ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(\S+)$/.exec(line);
    if (!kv) throw new PromptError(`${file}：无法解析 front matter 行「${line}」`);
    const key = kv[1]!;
    if (key !== "version") {
      throw new PromptError(`${file}：未知 front matter 键「${key}」（只支持 version）`);
    }
    const n = Number(kv[2]);
    if (!Number.isInteger(n) || n < 1) throw new PromptError(`${file}：version 必须是 ≥1 的整数`);
    version = n;
  }
  if (version === null) throw new PromptError(`${file}：front matter 缺少 version`);

  const sections: Partial<Record<SectionKey, string>> = {};
  let current: SectionKey | null = null;
  let body: string[] = [];
  const flush = () => {
    if (current === null) return;
    const content = body.join("\n").replace(/^\n+|\n+$/g, "");
    if (!content) throw new PromptError(`${file}：段落「${current}」为空`);
    sections[current] = content;
  };

  for (const line of text.slice(head[0].length).split("\n")) {
    const mark = SECTION_MARK.exec(line);
    if (mark) {
      flush();
      const key = mark[1]!;
      if (!(SECTION_KEYS as readonly string[]).includes(key)) {
        throw new PromptError(`${file}：未知段落「${key}」（可用：${SECTION_KEYS.join(", ")}）`);
      }
      if (sections[key as SectionKey] !== undefined) {
        throw new PromptError(`${file}：段落「${key}」重复`);
      }
      current = key as SectionKey;
      body = [];
      continue;
    }
    if (current === null) {
      if (line.trim()) throw new PromptError(`${file}：第一个段落标记之前出现正文`);
      continue;
    }
    body.push(line);
  }
  flush();

  if (Object.keys(sections).length === 0) throw new PromptError(`${file}：没有任何段落`);
  return { kind, file, version, sections };
}

/**
 * 提示词分层：内置 → 团队（prompts.dir/worker.md）→ 仓库（prompts.dir/repos/<别名>.md），
 * 按段落独立覆盖，未覆盖的段落回退到上一层。改动版本落在文件 front matter，重启生效。
 */
export class PromptLibrary {
  private readonly cache = new Map<string, ResolvedPrompts>();
  private builtin: PromptLayer | null = null;

  constructor(private readonly opts: PromptLibraryOptions = {}) {}

  private builtinLayer(): PromptLayer {
    if (this.builtin) return this.builtin;
    const file = join(this.opts.builtinDir ?? DEFAULT_BUILTIN_DIR, "worker.md");
    const layer = parsePromptFile(file, "builtin", true)!;
    const missing = SECTION_KEYS.filter((k) => layer.sections[k] === undefined);
    if (missing.length > 0) throw new PromptError(`${file}：缺少段落 ${missing.join(", ")}`);
    this.builtin = layer;
    return layer;
  }

  /** 仓库为 null/空时只应用内置与团队两层 */
  resolve(repo?: string | null): ResolvedPrompts {
    const key = repo ?? "";
    const cached = this.cache.get(key);
    if (cached) return cached;

    const builtin = this.builtinLayer();
    const teamDir = this.opts.teamDir ?? null;
    const team = teamDir ? parsePromptFile(join(teamDir, "worker.md"), "team", false) : null;
    const repoLayer =
      repo && teamDir && SAFE_ALIAS.test(repo)
        ? parsePromptFile(join(teamDir, "repos", `${repo}.md`), "repo", false)
        : null;

    const sections = {} as Record<SectionKey, ResolvedSection>;
    for (const k of SECTION_KEYS) {
      const builtinBody = builtin.sections[k]!;
      const override = repoLayer?.sections[k] !== undefined ? repoLayer : team?.sections[k] !== undefined ? team : null;
      sections[k] = {
        text: override?.sections[k] ?? builtinBody,
        source: override?.kind ?? "builtin",
        version: override?.version ?? builtin.version,
        builtinText: builtinBody,
        builtinVersion: builtin.version,
      };
    }

    const resolved: ResolvedPrompts = {
      repo: repo ?? null,
      builtinVersion: builtin.version,
      teamVersion: team?.version ?? null,
      repoVersion: repoLayer?.version ?? null,
      sections,
    };
    this.cache.set(key, resolved);
    return resolved;
  }

  /** 启动自检：读全部覆盖文件，非法配置直接抛出 */
  validate(repos: readonly string[]): void {
    // 团队层与仓库无关，先单独解析一次；仓库清单为空时同样要校验（FR-005）
    this.resolve(null);
    for (const repo of repos) this.resolve(repo);
  }
}

/** 渲染最终提示词；占位符只替换一次，正文里出现的同样文本保持原样 */
export function renderWorkerPrompt(
  resolved: ResolvedPrompts,
  task: Task,
  opts: { resume?: boolean } = {},
): string {
  const values: Record<string, string> = { taskId: task.id, prompt: task.prompt, context: task.context ?? "" };
  const render = (key: SectionKey) =>
    resolved.sections[key].text.replace(/\{\{(\w+)\}\}/g, (m, name: string) => values[name] ?? m);

  const parts = [render("intro")];
  if (opts.resume) parts.push(render("resume"));
  if (task.context) parts.push(render("context"));
  parts.push(render("task"), render("constraints"));
  return parts.join("\n\n");
}

function sourceText(section: ResolvedSection): string {
  return `${SOURCE_LABEL[section.source]} v${section.version}`;
}

function viewBlock(p: ResolvedPrompts): string {
  const layers = [`内置 v${p.builtinVersion}`];
  if (p.teamVersion !== null) layers.push(`团队 v${p.teamVersion}`);
  if (p.repoVersion !== null) layers.push(`仓库 v${p.repoVersion}`);
  const width = Math.max(...SECTION_KEYS.map((k) => k.length));
  const rows = SECTION_KEYS.map((k) => `  ${k.padEnd(width)}  ${sourceText(p.sections[k])}`);
  return [`${p.repo ? `[${p.repo}] ` : ""}worker · ${layers.join(" · ")}`, ...rows].join("\n");
}

type DiffOp = { op: " " | "-" | "+"; text: string; oldNo: number; newNo: number };

/** 行级 LCS + 3 行上下文，够看清单段改了什么 */
function unifiedDiff(from: string, to: string, fromLabel: string, toLabel: string): string {
  const a = from.split("\n");
  const b = to.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let oldNo = 1;
  let newNo = 1;
  let i = 0;
  let j = 0;
  const push = (op: DiffOp["op"], text: string) => {
    ops.push({ op, text, oldNo, newNo });
    if (op !== "+") oldNo += 1;
    if (op !== "-") newNo += 1;
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(" ", a[i]!);
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push("-", a[i]!);
      i += 1;
    } else {
      push("+", b[j]!);
      j += 1;
    }
  }
  while (i < n) {
    push("-", a[i]!);
    i += 1;
  }
  while (j < m) {
    push("+", b[j]!);
    j += 1;
  }

  const changed = ops.flatMap((o, idx) => (o.op === " " ? [] : [idx]));
  if (changed.length === 0) return "";

  const CONTEXT = 3;
  const ranges: Array<[number, number]> = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(ops.length - 1, idx + CONTEXT);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = end;
    else ranges.push([start, end]);
  }

  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end + 1);
    const oldStart = slice[0]!.oldNo;
    const newStart = slice[0]!.newNo;
    const oldCount = slice.filter((o) => o.op !== "+").length;
    const newCount = slice.filter((o) => o.op !== "-").length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of slice) out.push(`${o.op}${o.text}`);
  }
  return out.join("\n");
}

function diffBlock(p: ResolvedPrompts): string {
  const head = `${p.repo ? `[${p.repo}] ` : ""}worker · 内置 v${p.builtinVersion}`;
  const changed = SECTION_KEYS.filter((k) => p.sections[k].source !== "builtin");
  if (changed.length === 0) return `${head}\n全部段落使用内置 v${p.builtinVersion}，没有覆盖。`;
  const blocks = changed.map((k) => {
    const s = p.sections[k];
    const toLabel = `${SOURCE_LABEL[s.source]} v${s.version}`;
    const diff = unifiedDiff(s.builtinText, s.text, `内置 v${s.builtinVersion}`, toLabel);
    return `${k} · 内置 v${s.builtinVersion} → ${toLabel}\n${diff || `内容未改，仅版本不同（内置 v${s.builtinVersion} → ${toLabel}）`}`;
  });
  return [head, ...blocks].join("\n\n");
}

/** `/pisa prompts` 的视图；diff=true 只列被覆盖段落的统一 diff */
export function formatPrompts(list: readonly ResolvedPrompts[], opts: { diff?: boolean } = {}): string {
  return list.map((p) => (opts.diff ? diffBlock(p) : viewBlock(p))).join("\n\n");
}
