import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";

/**
 * 提示词是数据：`prompts/<id>/prompt.json` 给版本与段落顺序，`<key>.md` 给正文。
 * 团队目录（`prompts.dir`）用同样布局覆盖同名段落、追加新段落；变量与条件由代码声明。
 */

export const BUILTIN_PROMPT_DIR = join(import.meta.dir, "..", "prompts");

const SECTION_KEY = /^[a-z][a-z0-9-]*$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/** 每个提示词的模板变量；`when` 只能取本提示词的变量名 */
const PROMPT_VARS: Record<string, readonly string[]> = {
  worker: ["taskId", "prompt", "context", "resume"],
  review: ["repo", "number", "title", "baseRefName", "head", "headSha", "url", "diff"],
};

export class PromptConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptConfigError";
  }
}

export type SectionSource = "builtin" | "team";

export interface PromptSection {
  key: string;
  /** 变量为假时整段不渲染 */
  when?: string;
  body: string;
  source: SectionSource;
  /** 团队覆盖时的内置正文，供 diff */
  previous?: string;
}

export interface Prompt {
  id: string;
  /** 内置版本 */
  version: number;
  /** 团队版本；没有团队层为 null */
  teamVersion: number | null;
  sections: PromptSection[];
}

export type PromptVars = Record<string, string | boolean | null | undefined>;

export interface PromptSet {
  readonly ids: string[];
  /** 配置的团队目录；未配置为 null */
  readonly teamDir: string | null;
  /** 团队目录存在并参与合并 */
  readonly teamActive: boolean;
  get(id: string): Prompt;
  render(id: string, vars: PromptVars): string;
}

interface LayerSection {
  key: string;
  when?: string;
}

interface Layer {
  version: number;
  sections: LayerSection[];
  bodies: Map<string, string>;
}

function fail(where: string, message: string): never {
  throw new PromptConfigError(`${where}：${message}`);
}

function variablesOf(id: string, where: string): readonly string[] {
  const vars = PROMPT_VARS[id];
  if (!vars) return fail(where, `未知提示词 ${id}（代码里没有它的变量表）`);
  return vars;
}

function readJson(path: string, allowed: readonly string[]): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return fail(path, `不是合法 JSON（${(err as Error).message}）`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(path, "必须是对象");
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) fail(path, `未知键 ${key}（允许：${allowed.join("、")}）`);
  }
  return raw as Record<string, unknown>;
}

function readVersion(where: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fail(where, `version 需要正整数，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function readSections(where: string, value: unknown, vars: readonly string[]): LayerSection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(where, "sections 需要数组");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const at = `${where} sections[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return fail(at, "需要 {key, when?}");
    for (const key of Object.keys(item)) {
      if (key !== "key" && key !== "when") fail(at, `未知键 ${key}（允许：key、when）`);
    }
    const { key, when } = item as { key?: unknown; when?: unknown };
    if (typeof key !== "string" || !SECTION_KEY.test(key)) return fail(at, "key 需要小写字母开头的 a-z0-9- 名称");
    if (seen.has(key)) fail(at, `重复的段落 ${key}`);
    seen.add(key);
    if (when !== undefined) {
      if (typeof when !== "string" || !vars.includes(when)) {
        fail(at, `when 只能用变量 ${vars.join("、")}，收到 ${JSON.stringify(when)}`);
      }
    }
    return typeof when === "string" ? { key, when } : { key };
  });
}

function readBody(dir: string, key: string, vars: readonly string[]): string {
  const path = join(dir, `${key}.md`);
  if (!existsSync(path)) return fail(dir, `缺少段落文件 ${key}.md`);
  const body = readFileSync(path, "utf8").trim();
  if (!body) return fail(path, "段落正文为空");
  for (const match of body.matchAll(PLACEHOLDER)) {
    if (!vars.includes(match[1] as string)) fail(path, `未知变量 {{${match[1]}}}（可用：${vars.join("、")}）`);
  }
  return body;
}

function loadBuiltin(dir: string, id: string): Layer {
  const manifestPath = join(dir, "prompt.json");
  if (!existsSync(manifestPath)) fail(dir, "缺 prompt.json");
  const vars = variablesOf(id, dir);
  const manifest = readJson(manifestPath, ["version", "sections"]);
  const version = readVersion(manifestPath, manifest.version);
  const sections = readSections(manifestPath, manifest.sections, vars);
  if (sections.length === 0) fail(manifestPath, "sections 不能为空");
  const bodies = new Map<string, string>();
  for (const section of sections) bodies.set(section.key, readBody(dir, section.key, vars));
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const declared = entry.isFile() && name.endsWith(".md") && bodies.has(name.slice(0, -3));
    if (!entry.isFile() || (name !== "prompt.json" && !declared)) fail(dir, `未知文件 ${name}`);
  }
  return { version, sections, bodies };
}

function loadTeam(dir: string, id: string, builtin: Layer): Layer | null {
  const vars = variablesOf(id, dir);
  const manifestPath = join(dir, "prompt.json");
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) if (!entry.isFile()) fail(dir, `未知目录 ${entry.name}`);
  const files = entries.map((e) => e.name);
  if (!existsSync(manifestPath)) {
    if (files.some((name) => name.endsWith(".md"))) fail(dir, "缺 prompt.json：团队覆盖必须声明 version");
    return null;
  }
  const manifest = readJson(manifestPath, ["version", "sections"]);
  const version = readVersion(manifestPath, manifest.version);
  const extras = readSections(manifestPath, manifest.sections, vars);
  for (const extra of extras) {
    if (builtin.bodies.has(extra.key)) {
      fail(manifestPath, `段落 ${extra.key} 已在内置里；覆盖请直接放 ${extra.key}.md，不要写进 sections`);
    }
  }
  const declared = [...builtin.sections, ...extras];
  const bodies = new Map<string, string>();
  for (const section of declared) {
    if (existsSync(join(dir, `${section.key}.md`))) bodies.set(section.key, readBody(dir, section.key, vars));
    else if (!builtin.bodies.has(section.key)) fail(dir, `sections 声明的 ${section.key} 缺少 ${section.key}.md`);
  }
  for (const name of files) {
    if (name === "prompt.json") continue;
    const key = name.endsWith(".md") ? name.slice(0, -3) : null;
    if (!key || !declared.some((section) => section.key === key)) {
      fail(dir, `未知段落文件 ${name}（新增段落要在 prompt.json 的 sections 里声明）`);
    }
  }
  if (bodies.size === 0) fail(dir, "没有覆盖任何段落");
  return { version, sections: extras, bodies };
}

function compose(id: string, builtin: Layer, team: Layer | null): Prompt {
  const sections = [...builtin.sections, ...(team?.sections ?? [])].map((section): PromptSection => {
    const body = team?.bodies.get(section.key);
    if (body === undefined) {
      return { key: section.key, when: section.when, body: builtin.bodies.get(section.key)!, source: "builtin" };
    }
    return { key: section.key, when: section.when, body, source: "team", previous: builtin.bodies.get(section.key) };
  });
  return { id, version: builtin.version, teamVersion: team?.version ?? null, sections };
}

function makeSet(prompts: Map<string, Prompt>, teamDir: string | null, teamActive: boolean): PromptSet {
  const ids = [...prompts.keys()].sort();
  const find = (id: string): Prompt => {
    const prompt = prompts.get(id);
    if (!prompt) return fail(`提示词 ${id}`, `未知提示词（可用：${ids.join("、")}）`);
    return prompt;
  };
  return {
    ids,
    teamDir,
    teamActive,
    get: find,
    render(id, vars) {
      const prompt = find(id);
      const parts: string[] = [];
      for (const section of prompt.sections) {
        if (section.when && !vars[section.when]) continue;
        parts.push(
          section.body.replace(PLACEHOLDER, (_, name: string) => {
            const value = vars[name];
            if (typeof value !== "string") {
              throw new PromptConfigError(`${id}/${section.key}：渲染缺少变量 {{${name}}}`);
            }
            return value;
          }),
        );
      }
      return parts.join("\n\n");
    },
  };
}

export interface LoadPromptOptions {
  builtinDir?: string;
  teamDir?: string | null;
}

/** 加载内置层与团队层；配置非法抛 PromptConfigError */
export function loadPromptSet(opts: LoadPromptOptions = {}): PromptSet {
  const builtinDir = opts.builtinDir ?? BUILTIN_PROMPT_DIR;
  if (!existsSync(builtinDir)) fail(builtinDir, "内置提示词目录不存在");

  const builtinIds = new Map<string, Layer>();
  for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) fail(builtinDir, `未知文件 ${entry.name}`);
    variablesOf(entry.name, builtinDir);
    builtinIds.set(entry.name, loadBuiltin(join(builtinDir, entry.name), entry.name));
  }
  if (builtinIds.size === 0) fail(builtinDir, "没有提示词");

  const teamDir = opts.teamDir ?? null;
  const teamActive = teamDir !== null && existsSync(teamDir);
  const merged = new Map<string, Prompt>();
  for (const [id, builtin] of builtinIds) merged.set(id, compose(id, builtin, null));
  if (teamActive) {
    const dir = teamDir as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !builtinIds.has(entry.name)) fail(dir, `未知提示词 ${entry.name}`);
      const team = loadTeam(join(dir, entry.name), entry.name, builtinIds.get(entry.name)!);
      if (team) merged.set(entry.name, compose(entry.name, builtinIds.get(entry.name)!, team));
    }
  }
  return makeSet(merged, teamDir, teamActive);
}

let builtinCache: PromptSet | null = null;

/** 只用内置提示词；测试与未注入的调用点共用一份 */
export function defaultPromptSet(): PromptSet {
  builtinCache ??= loadPromptSet();
  return builtinCache;
}

/** 启动路径：内置 + 配置里的团队目录 */
export function loadProjectPrompts(cfg: Config): PromptSet {
  return loadPromptSet({ teamDir: cfg.prompts?.dir ?? null });
}

function versionLabel(prompt: Prompt): string {
  if (prompt.teamVersion === null) return `内置 v${prompt.version}`;
  const overridden = prompt.sections.filter((s) => s.source === "team" && s.previous !== undefined).length;
  const added = prompt.sections.filter((s) => s.source === "team" && s.previous === undefined).length;
  const detail = [overridden > 0 ? `覆盖 ${overridden} 段` : "", added > 0 ? `新增 ${added} 段` : ""].filter(Boolean);
  return `团队 v${prompt.teamVersion} · ${detail.join("，")}（内置 v${prompt.version}）`;
}

export function formatPromptList(set: PromptSet, trigger: string): string {
  const lines = ["提示词 · 当前生效版本"];
  for (const id of set.ids) lines.push(`${id} · ${versionLabel(set.get(id))}`);
  if (set.teamDir === null) lines.push("团队目录：未配置（只用内置提示词）");
  else lines.push(`团队目录：${set.teamDir}${set.teamActive ? "" : "（不存在，按内置）"}`);
  const first = set.ids[0];
  if (first) lines.push(`段落与来源：${trigger} prompts ${first}`, `与内置的差异：${trigger} prompts ${first} diff`);
  return lines.join("\n");
}

export function formatPromptSections(prompt: Prompt): string {
  const lines = [`${prompt.id} · ${versionLabel(prompt)}`, "段落："];
  prompt.sections.forEach((section, index) => {
    const source = section.source === "team" ? (section.previous === undefined ? "团队新增" : "团队覆盖") : "内置";
    const cond = section.when ? ` · 仅当 ${section.when} 有值` : "";
    lines.push(` ${index + 1}. ${section.key} · ${source}${cond}`);
  });
  return lines.join("\n");
}

/** 逐行 LCS：段落不大，直接给完整段落的 -/+ 对比 */
function lineDiff(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
}

export function formatPromptDiff(prompt: Prompt): string {
  if (prompt.teamVersion === null) return `${prompt.id} · 内置 v${prompt.version} · 没有团队覆盖，当前即内置提示词`;
  const changed = prompt.sections.filter((section) => section.source === "team");
  if (changed.length === 0) return `${prompt.id} · 团队 v${prompt.teamVersion} 与内置 v${prompt.version} 相同`;
  const lines = [`${prompt.id} · 内置 v${prompt.version} → 团队 v${prompt.teamVersion}`];
  for (const section of changed) {
    if (section.previous === undefined) {
      lines.push(`「${section.key}」团队新增`);
      for (const line of section.body.split("\n")) lines.push(`+ ${line}`);
    } else {
      lines.push(`「${section.key}」团队覆盖`);
      lines.push(...lineDiff(section.previous, section.body));
    }
  }
  return lines.join("\n");
}

/** `/pisa prompts [<id> [diff]]` */
export function formatPromptsCommand(set: PromptSet, body: string, trigger: string): string {
  const [id, mode] = body.trim().split(/\s+/).filter(Boolean);
  if (!id) return formatPromptList(set, trigger);
  if (!set.ids.includes(id)) return `未知提示词：${id}（可用：${set.ids.join("、")}）`;
  const prompt = set.get(id);
  if (!mode) return formatPromptSections(prompt);
  if (mode === "diff") return formatPromptDiff(prompt);
  return `未知参数：${mode}；用法：${trigger} prompts ${id} [diff]`;
}
