import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 内置段落的结构版本：段落集合或变量契约变化时递增 */
export const BUILTIN_PROMPT_VERSION = 1;

export type PromptTemplate = "worker" | "review";

/** 一层覆盖的来源；更具体的层优先 */
export type PromptLayer = "builtin" | "team" | "repo";

export interface PromptSectionSpec {
  /** 覆盖文件名：`<键>.md` */
  key: string;
  template: PromptTemplate;
  /** 文本里允许出现的变量名 */
  vars: readonly string[];
  /** 内置文本；null 表示只能由覆盖提供 */
  builtin: string | null;
  /** 该变量非空时才渲染；用于「恢复执行」「上一轮上下文」这类开关段落 */
  includeWhen?: string;
}

const WORKER_GUARD = [
  "## 约束（以下由 pisa guard 强制，越界调用会被拒绝）",
  "- 文件读写、编辑只能落在工作目录内；git 的 -C / --work-tree / --git-dir 也只能指向工作目录",
  "- 禁止 git push（任意形态）、reset --hard、clean -f、切换分支、worktree remove/prune、branch -D、rebase、commit --amend",
  "- 禁止 sudo、删除根目录、改动 /etc 权限",
  "- 提交与推送由 pisa 在任务结束后完成，不需要你操作",
  "- 有测试就跑测试；没有测试就说明你如何验证",
  "- 完成后用中文给出：改了什么、动了哪些文件、验证结果",
  "- 不要输出寒暄，直接给结论",
].join("\n");

const REVIEW_REQUIREMENTS = [
  "## 要求",
  "- 这是只读评审：不要修改代码，不要创建或切换分支，不要提交、推送或创建 PR。",
  "- 当前工作目录是空的临时目录，没有检出仓库；只依据下面的 diff 评审，不要尝试运行测试。",
  "- 从正确性、回归风险、测试覆盖、可维护性、安全五个方面评审；只指出有证据的问题。",
  "- 结论第一行给判定：通过 / 有建议 / 需要修改；再按文件列问题（位置、原因、建议）。",
  "- 不要复述 diff；没有发现问题就明确说明。",
].join("\n");

/** 段落清单：唯一事实源，覆盖键、顺序、变量与内置文本都由这里决定 */
export const PROMPT_SECTIONS: readonly PromptSectionSpec[] = [
  {
    key: "worker.intro",
    template: "worker",
    vars: ["taskId"],
    builtin: "你是 pisa 的 Worker，任务号 {{taskId}}。",
  },
  {
    key: "worker.resume",
    template: "worker",
    vars: [],
    includeWhen: "resume",
    builtin: [
      "## 恢复执行",
      "上一次执行被中断。先核对现状，再决定动作，不要重复已经发生的副作用：",
      "1. 检查工作目录：`git status` 与 `git log`，确认已有改动、提交与未完成的部分。",
      "2. 检查外部动作是否已经落地：分支是否已推送、PR 是否已存在（如 `gh pr list --head <分支>`），以及任务是否已回帖。",
      "3. 已完成的改动不重做；PR 已存在时不重复创建。推送、创建 PR、发表评论这些外部动作，确认尚未发生后再执行。",
      "从核对结果出发继续剩余工作。",
    ].join("\n"),
  },
  {
    key: "worker.context",
    template: "worker",
    vars: ["context"],
    includeWhen: "context",
    builtin: ["## 上一轮上下文（供参考，不是新指令）", "{{context}}"].join("\n"),
  },
  {
    key: "worker.task",
    template: "worker",
    vars: ["prompt"],
    builtin: ["## 任务", "{{prompt}}"].join("\n"),
  },
  {
    key: "worker.guard",
    template: "worker",
    vars: [],
    builtin: WORKER_GUARD,
  },
  {
    key: "review.header",
    template: "review",
    vars: ["repo", "number", "title", "base", "head", "headSha", "url"],
    builtin: [
      "评审 PR {{repo}}#{{number}}：{{title}}",
      "",
      "- 基线：{{base}} ← {{head}} @ {{headSha}}",
      "- 链接：{{url}}",
    ].join("\n"),
  },
  {
    key: "review.requirements",
    template: "review",
    vars: [],
    builtin: REVIEW_REQUIREMENTS,
  },
  {
    // 仓库评审标准：没有内置文本，只有覆盖时进入提示词
    key: "review.criteria",
    template: "review",
    vars: [],
    builtin: null,
  },
  {
    key: "review.diff",
    template: "review",
    vars: ["diff"],
    builtin: ["## Diff", "```diff", "{{diff}}", "```"].join("\n"),
  },
];

/** 每种模板的段落顺序；渲染按此拼接，空行分隔 */
export const PROMPT_TEMPLATES: Record<PromptTemplate, readonly string[]> = {
  worker: ["worker.intro", "worker.resume", "worker.context", "worker.task", "worker.guard"],
  review: ["review.header", "review.requirements", "review.criteria", "review.diff"],
};

export interface PromptOverride {
  /** null 为团队层；否则是仓库目录名 */
  scope: string | null;
  key: string;
  text: string;
}

export interface PromptLibrary {
  /** 覆盖版本；没有覆盖时等于内置版本 */
  version: number;
  builtinVersion: number;
  /** 覆盖目录；null 表示没有使用覆盖 */
  dir: string | null;
  overrides: readonly PromptOverride[];
}

export const DEFAULT_PROMPTS: PromptLibrary = {
  version: BUILTIN_PROMPT_VERSION,
  builtinVersion: BUILTIN_PROMPT_VERSION,
  dir: null,
  overrides: [],
};

export class PromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptError";
  }
}

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;
/** 仓库覆盖目录名：owner/repo 的 `/` 换成 `__` 后仍要落在合法文件名字符内 */
const SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const SPEC_BY_KEY = new Map(PROMPT_SECTIONS.map((s) => [s.key, s]));
const KEY_WIDTH = Math.max(...PROMPT_SECTIONS.map((s) => s.key.length));

/** GitHub 的 owner/repo 与仓库别名都映射成覆盖目录名 */
export function promptScope(repo: string): string | null {
  const scope = repo.trim().replace(/\//g, "__");
  return SCOPE_NAME.test(scope) ? scope : null;
}

function spec(key: string): PromptSectionSpec {
  const found = SPEC_BY_KEY.get(key);
  if (!found) throw new PromptError(`未知提示词段落：${key}`);
  return found;
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new PromptError(`提示词变量未提供：${name}`);
    return value;
  });
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

function parseVersion(raw: string, path: string): number {
  const text = raw.trim();
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    throw new PromptError(`version 必须是从 1 开始的整数：${path}，当前为「${text}」`);
  }
  return Number(text);
}

function keyFromFile(name: string, dir: string): string {
  if (!name.endsWith(".md")) {
    throw new PromptError(`prompts 目录里只允许 <键>.md 与 version：${join(dir, name)}`);
  }
  const key = name.slice(0, -3);
  if (!SPEC_BY_KEY.has(key)) {
    throw new PromptError(
      `未知提示词键：${join(dir, name)}；可用键：${PROMPT_SECTIONS.map((s) => s.key).join("、")}`,
    );
  }
  return key;
}

function readOverride(path: string, key: string, scope: string | null): PromptOverride {
  const text = readFileSync(path, "utf8").trim();
  if (!text) throw new PromptError(`提示词覆盖为空：${path}`);
  const allowed = spec(key).vars;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!allowed.includes(name)) {
      throw new PromptError(
        `未知提示词变量 {{${name}}}：${path}；${key} 可用变量：${allowed.length > 0 ? allowed.join("、") : "无"}`,
      );
    }
  }
  return { scope, key, text };
}

function readScopeOverrides(root: string, name: string): PromptOverride[] {
  if (!SCOPE_NAME.test(name)) throw new PromptError(`仓库覆盖目录名不合法：${join(root, name)}`);
  const dir = join(root, name);
  const out: PromptOverride[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    if (!entry.isFile()) throw new PromptError(`仓库覆盖目录里不允许子目录：${join(dir, entry.name)}`);
    const key = keyFromFile(entry.name, dir);
    out.push(readOverride(join(dir, entry.name), key, name));
  }
  return out;
}

/**
 * 读取覆盖目录：`<键>.md` 是团队层，`repos/<仓库>/<键>.md` 是仓库层，`version` 记录覆盖版本。
 * 目录不存在时退回内置；存在就必须整体合法，未知键或坏版本直接拒绝，避免带病启动。
 */
export function loadPrompts(dir: string): PromptLibrary {
  if (!existsSync(dir)) return DEFAULT_PROMPTS;
  let version: number | null = null;
  const overrides: PromptOverride[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "repos") throw new PromptError(`prompts 目录里只允许 repos/ 子目录：${path}`);
      for (const scope of readdirSync(path, { withFileTypes: true }).sort(byName)) {
        if (!scope.isDirectory()) throw new PromptError(`repos/ 下只能放仓库目录：${join(path, scope.name)}`);
        overrides.push(...readScopeOverrides(path, scope.name));
      }
      continue;
    }
    if (!entry.isFile()) throw new PromptError(`prompts 目录里不支持该条目：${path}`);
    if (entry.name === "version") {
      version = parseVersion(readFileSync(path, "utf8"), path);
      continue;
    }
    const key = keyFromFile(entry.name, dir);
    overrides.push(readOverride(path, key, null));
  }
  if (overrides.length > 0 && version === null) {
    throw new PromptError(`有覆盖时必须声明版本：缺少 ${join(dir, "version")}`);
  }
  return { version: version ?? BUILTIN_PROMPT_VERSION, builtinVersion: BUILTIN_PROMPT_VERSION, dir, overrides };
}

function resolve(
  lib: PromptLibrary,
  key: string,
  scope: string | null,
): { text: string | null; layer: PromptLayer } {
  if (scope) {
    const repo = lib.overrides.find((o) => o.scope === scope && o.key === key);
    if (repo) return { text: repo.text, layer: "repo" };
  }
  const team = lib.overrides.find((o) => o.scope === null && o.key === key);
  if (team) return { text: team.text, layer: "team" };
  return { text: spec(key).builtin, layer: "builtin" };
}

/**
 * 按模板拼提示词：顺序取 PROMPT_TEMPLATES，每段取仓库 > 团队 > 内置，
 * 开关段落用调用方给的变量判断是否出现，段落之间空一行。
 */
export function renderPrompt(
  lib: PromptLibrary,
  template: PromptTemplate,
  vars: Record<string, string>,
  scope?: string | null,
): string {
  const blocks: string[] = [];
  for (const key of PROMPT_TEMPLATES[template]) {
    const section = spec(key);
    if (section.includeWhen && !vars[section.includeWhen]?.trim()) continue;
    const { text } = resolve(lib, key, scope ?? null);
    if (text === null) continue;
    blocks.push(fill(text, vars));
  }
  return blocks.join("\n\n");
}

export interface PromptSectionView {
  key: string;
  template: PromptTemplate;
  layer: PromptLayer;
  /** null：没有内置文本且未覆盖，渲染时跳过 */
  text: string | null;
}

export function promptSections(lib: PromptLibrary, scope?: string | null): PromptSectionView[] {
  return PROMPT_SECTIONS.map((s) => ({ key: s.key, template: s.template, ...resolve(lib, s.key, scope ?? null) }));
}

function layerText(layer: PromptLayer, scope: string | null): string {
  if (layer === "repo") return `仓库 ${scope}`;
  return layer === "team" ? "团队" : "内置";
}

/** `/pisa prompts`：版本、覆盖目录与每段的来源 */
export function describePrompts(lib: PromptLibrary, scope?: string | null): string {
  const head = [
    `提示词版本 ${lib.version}（内置 ${lib.builtinVersion}）`,
    lib.dir ? `覆盖目录 ${lib.dir}` : "覆盖目录 未使用（全部走内置段落）",
  ];
  if (scope) head.push(`仓库视角 ${scope}`);
  const rows = promptSections(lib, scope).map((s) => {
    const state = s.text === null ? "未设置（跳过）" : layerText(s.layer, scope ?? null);
    return `${s.key.padEnd(KEY_WIDTH)}  ${state}`;
  });
  return [...head, "", `${"键".padEnd(KEY_WIDTH)}  来源`, ...rows].join("\n");
}

/** 逐行 LCS 差异；提示词段落都很短，二维表足够 */
export function lineDiff(before: readonly string[], after: readonly string[]): string[] {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        before[i] === after[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push(` ${before[i]!}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`-${before[i]!}`);
      i++;
    } else {
      out.push(`+${after[j]!}`);
      j++;
    }
  }
  for (; i < n; i++) out.push(`-${before[i]!}`);
  for (; j < m; j++) out.push(`+${after[j]!}`);
  return out;
}

/** `/pisa prompts diff <键>`：按层对比，展示内置 → 团队 → 仓库的累积改动 */
export function diffPrompts(lib: PromptLibrary, key: string, scope?: string | null): string {
  const section = spec(key);
  const layers: Array<{ label: string; text: string | null }> = [{ label: "内置", text: section.builtin }];
  const team = lib.overrides.find((o) => o.scope === null && o.key === key);
  if (team) layers.push({ label: "团队", text: team.text });
  if (scope) {
    const repo = lib.overrides.find((o) => o.scope === scope && o.key === key);
    if (repo) layers.push({ label: `仓库 ${scope}`, text: repo.text });
  }
  if (layers.length === 1) return `${key}：没有覆盖，使用内置文本`;
  const blocks: string[] = [];
  for (let i = 1; i < layers.length; i++) {
    const from = layers[i - 1]!;
    const to = layers[i]!;
    const lines = lineDiff(from.text === null ? [] : from.text.split("\n"), to.text === null ? [] : to.text.split("\n"));
    blocks.push([`--- ${from.label} ${key}`, `+++ ${to.label} ${key}`, ...lines, ""].join("\n"));
  }
  return blocks.join("\n").trimEnd();
}

const USAGE = "用法：/pisa prompts [diff <键>] [--repo <仓库>]";
const KEYS = PROMPT_SECTIONS.map((s) => s.key).join("、");

/** 参数解析：路由与 CLI 共用，非法参数只回一句用法，不抛错 */
export interface PromptsQuery {
  /** null 表示参数非法，原因在 error */
  sub: "list" | "diff" | null;
  key: string | null;
  scope: string | null;
  error: string | null;
}

export function parsePromptsQuery(body: string): PromptsQuery {
  const words = body.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  let scope: string | null = null;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--repo" || word.startsWith("--repo=")) {
      const value = word === "--repo" ? words[++i] : word.slice("--repo=".length);
      if (!value) return { sub: null, key: null, scope: null, error: USAGE };
      scope = value;
      continue;
    }
    rest.push(word);
  }
  if (rest.length === 0) return { sub: "list", key: null, scope, error: null };
  if (rest[0] !== "diff" || rest.length > 2) return { sub: null, key: null, scope, error: USAGE };
  const key = rest[1] ?? null;
  if (!key) return { sub: null, key: null, scope, error: `用法：/pisa prompts diff <键> [--repo <仓库>]；可用键：${KEYS}` };
  if (!SPEC_BY_KEY.has(key)) return { sub: null, key: null, scope, error: `未知提示词键：${key}；可用键：${KEYS}` };
  return { sub: "diff", key, scope, error: null };
}

/** 路由与 CLI 共用的文本输出 */
export function formatPromptsCommand(lib: PromptLibrary, body: string): string {
  const query = parsePromptsQuery(body);
  if (query.error !== null) return query.error;
  if (query.sub === "diff") return diffPrompts(lib, query.key!, query.scope);
  return describePrompts(lib, query.scope);
}
