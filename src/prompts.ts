import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 提示词段落：拼接顺序就是这里的顺序 */
export const SEGMENT_KEYS = ["intro", "resume", "context", "task", "constraints"] as const;
export type SegmentKey = (typeof SEGMENT_KEYS)[number];

export const PROMPTS_DIR = "prompts";
export const BUILTIN_FILE = "builtin.json";
export const TEAM_FILE = "team.json";

/** 段落里允许出现的占位符 */
const PLACEHOLDERS: Record<string, true> = { id: true, prompt: true, context: true };
const PLACEHOLDER = /\{\{\s*([\w-]+)\s*\}\}/g;

type Source = "builtin" | "team";

export interface PromptVars {
  id: string;
  prompt: string;
  context?: string | null;
}

interface PromptLayer {
  version: number;
  segments: Partial<Record<SegmentKey, string>>;
}

export interface PromptSet {
  /** 提示词目录绝对路径：展示与报错都用它 */
  dir: string;
  builtin: PromptLayer;
  /** 没有 team.json 时为 null */
  team: PromptLayer | null;
  /** 生效段落 */
  segments: Record<SegmentKey, string>;
  /** 每个段落最终来自哪一层 */
  sources: Record<SegmentKey, Source>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSegmentKey = (key: string): key is SegmentKey => (SEGMENT_KEYS as readonly string[]).includes(key);

/** 读一层提示词并校验；requireAll 用于内置层 */
function readLayer(path: string, requireAll: boolean): PromptLayer {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`缺少提示词文件：${path}`);
    throw new Error(`提示词文件不是合法 JSON：${path}（${(err as Error).message}）`);
  }
  if (!isObject(raw)) throw new Error(`${path}：顶层必须是对象`);

  for (const key of Object.keys(raw)) {
    if (key !== "version" && key !== "segments") throw new Error(`${path}：未知顶层键「${key}」`);
  }

  const { version, segments: spec } = raw;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error(`${path}：version 必须是正整数`);
  }
  if (!isObject(spec)) throw new Error(`${path}：segments 必须是对象`);

  const segments: Partial<Record<SegmentKey, string>> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (!isSegmentKey(key)) {
      throw new Error(`${path}：未知段落「${key}」（可用：${SEGMENT_KEYS.join(", ")}）`);
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${path}：段落「${key}」必须是非空字符串`);
    }
    for (const match of value.matchAll(PLACEHOLDER)) {
      const name = match[1]!;
      if (!Object.hasOwn(PLACEHOLDERS, name)) {
        throw new Error(
          `${path}：段落「${key}」包含未知占位符「{{${name}}}」（可用：${Object.keys(PLACEHOLDERS).join(", ")}）`,
        );
      }
    }
    segments[key] = value;
  }

  if (requireAll) {
    const missing = SEGMENT_KEYS.filter((key) => segments[key] === undefined);
    if (missing.length > 0) throw new Error(`${path}：缺少段落 ${missing.join(", ")}`);
  } else if (Object.keys(segments).length === 0) {
    throw new Error(`${path}：segments 不能为空，不需要覆盖就删掉这个文件`);
  }

  return { version, segments };
}

/** 启动期装载：内置层 + 可选的团队覆盖层 */
export function loadPrompts(dir = PROMPTS_DIR): PromptSet {
  const abs = resolve(dir);
  const builtinPath = resolve(abs, BUILTIN_FILE);
  if (!existsSync(builtinPath)) throw new Error(`缺少内置提示词：${builtinPath}`);
  const builtin = readLayer(builtinPath, true);

  const teamPath = resolve(abs, TEAM_FILE);
  const team = existsSync(teamPath) ? readLayer(teamPath, false) : null;

  const segments = {} as Record<SegmentKey, string>;
  const sources = {} as Record<SegmentKey, Source>;
  for (const key of SEGMENT_KEYS) {
    const override = team?.segments[key];
    if (override === undefined) {
      segments[key] = builtin.segments[key]!;
      sources[key] = "builtin";
    } else {
      segments[key] = override;
      sources[key] = "team";
    }
  }

  return { dir: abs, builtin, team, segments, sources };
}

/**
 * 按固定顺序拼接段落。
 * resume 只在恢复执行时出现；context 只在上轮上下文非空时出现。
 */
export function renderPrompt(set: PromptSet, vars: PromptVars, opts: { resume?: boolean } = {}): string {
  const values: Record<string, string> = { id: vars.id, prompt: vars.prompt, context: vars.context ?? "" };
  return SEGMENT_KEYS.filter((key) => {
    if (key === "resume") return Boolean(opts.resume);
    if (key === "context") return values.context !== "";
    return true;
  })
    .map((key) => set.segments[key].replace(PLACEHOLDER, (_all, name: string) => values[name] ?? ""))
    .join("\n\n");
}

/** 行级差异：最小 LCS 对齐，输出 `-` / `+` / 空格前缀 */
export function diffLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push(`-${a[i]!}`);
      i += 1;
    } else {
      out.push(`+${b[j]!}`);
      j += 1;
    }
  }
  while (i < a.length) out.push(`-${a[i++]!}`);
  while (j < b.length) out.push(`+${b[j++]!}`);
  return out;
}

/** `/pisa prompts`：分层、版本与每段来源 */
export function formatPromptSummary(set: PromptSet, trigger = "/pisa"): string {
  const header = set.team
    ? `提示词 · 内置 v${set.builtin.version} · 覆盖 v${set.team.version}`
    : `提示词 · 内置 v${set.builtin.version} · 无覆盖`;
  const lines = [header, `目录：${set.dir}`, "段落（生效来源）"];
  for (const key of SEGMENT_KEYS) lines.push(`- ${key} · ${set.sources[key] === "team" ? "覆盖" : "内置"}`);
  lines.push(`用 ${trigger} prompts diff 查看覆盖差异。`);
  return lines.join("\n");
}

/** `/pisa prompts diff`：被覆盖段落的行级差异 */
export function formatPromptDiff(set: PromptSet): string {
  if (!set.team) return `没有覆盖层，全部使用内置 v${set.builtin.version}。`;
  const lines = [`内置 v${set.builtin.version} → 覆盖 v${set.team.version}`];
  for (const key of SEGMENT_KEYS) {
    const override = set.team.segments[key];
    if (override === undefined) continue;
    lines.push("", `## ${key}`);
    const base = set.builtin.segments[key]!;
    if (override === base) lines.push("（与内置一致）");
    else lines.push(...diffLines(base, override));
  }
  return lines.join("\n");
}
