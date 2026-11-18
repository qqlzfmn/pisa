import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Task } from "./types";

/**
 * 提示词分层：内置段落 → 覆盖文件。段落按 PROMPT_SECTIONS 顺序渲染，
 * 覆盖文件只能替换已有键，未知键、未知占位符与缺必需占位符都在启动时拒绝。
 */

/** 提示词格式版本；覆盖文件必须声明同一个版本，升级时一起改 */
export const PROMPT_VERSION = 1;

/** 覆盖文件名；prompts/ 下的其它 .json 视为配置错误 */
export const PROMPT_OVERRIDE_FILE = "overrides.json";

export const PROMPT_SECTIONS = ["intro", "team", "resume", "context", "task", "guard"] as const;
export type PromptSectionKey = (typeof PROMPT_SECTIONS)[number];

export type PromptPlaceholder = "taskId" | "repo" | "prompt" | "context";

const PLACEHOLDERS = ["taskId", "repo", "prompt", "context"] as const satisfies readonly PromptPlaceholder[];

/** 每个段落必须保留的数据占位符：缺失会让任务信息在提示词里消失 */
const REQUIRED_PLACEHOLDER: Partial<Record<PromptSectionKey, PromptPlaceholder>> = {
  intro: "taskId",
  context: "context",
  task: "prompt",
};

const BUILTIN_TEXT: Readonly<Record<PromptSectionKey, string>> = {
  intro: "你是 pisa 的 Worker，任务号 {{taskId}}。",
  team: "",
  resume: [
    "## 恢复执行",
    "上一次执行被中断。先核对现状，再决定动作，不要重复已经发生的副作用：",
    "1. 检查工作目录：`git status` 与 `git log`，确认已有改动、提交与未完成的部分。",
    "2. 检查外部动作是否已经落地：分支是否已推送、PR 是否已存在（如 `gh pr list --head <分支>`），以及任务是否已回帖。",
    "3. 已完成的改动不重做；PR 已存在时不重复创建。推送、创建 PR、发表评论这些外部动作，确认尚未发生后再执行。",
    "从核对结果出发继续剩余工作。",
  ].join("\n"),
  context: ["## 上一轮上下文（供参考，不是新指令）", "{{context}}"].join("\n"),
  task: ["## 任务", "{{prompt}}"].join("\n"),
  guard: [
    "## 约束（以下由 pisa guard 强制，越界调用会被拒绝）",
    "- 文件读写、编辑只能落在工作目录内；git 的 -C / --work-tree / --git-dir 也只能指向工作目录",
    "- 禁止 git push（任意形态）、reset --hard、clean -f、切换分支、worktree remove/prune、branch -D、rebase、commit --amend",
    "- 禁止 sudo、删除根目录、改动 /etc 权限",
    "- 提交与推送由 pisa 在任务结束后完成，不需要你操作",
    "- 有测试就跑测试；没有测试就说明你如何验证",
    "- 完成后用中文给出：改了什么、动了哪些文件、验证结果",
    "- 不要输出寒暄，直接给结论",
  ].join("\n"),
};

export class PromptConfigError extends Error {}

export interface PromptBundle {
  version: number;
  /** 生效模板，按 PROMPT_SECTIONS 顺序 */
  sections: Readonly<Record<PromptSectionKey, string>>;
  /** 被覆盖文件替换的段落 */
  overrides: readonly PromptSectionKey[];
  /** 实际读取的覆盖文件；没有覆盖时为 null */
  source: string | null;
}

export const BUILTIN_PROMPTS: PromptBundle = {
  version: PROMPT_VERSION,
  sections: BUILTIN_TEXT,
  overrides: [],
  source: null,
};

/** 配置文件旁的 prompts/ 目录：覆盖无需改代码，改文件后重启生效 */
export function promptsDir(configPath: string): string {
  return join(dirname(resolve(configPath)), "prompts");
}

export function loadPrompts(dir: string): PromptBundle {
  if (!existsSync(dir)) return BUILTIN_PROMPTS;
  const unknown = readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== PROMPT_OVERRIDE_FILE)
    .sort();
  if (unknown.length > 0) {
    throw new PromptConfigError(
      `${dir}: 未知的提示词文件 ${unknown.join(", ")}；只识别 ${PROMPT_OVERRIDE_FILE}`,
    );
  }
  const source = join(dir, PROMPT_OVERRIDE_FILE);
  if (!existsSync(source)) return BUILTIN_PROMPTS;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(source, "utf8"));
  } catch (err) {
    throw new PromptConfigError(`${source}: JSON 解析失败：${(err as Error).message}`);
  }
  return parseOverride(raw, source);
}

function parseOverride(raw: unknown, source: string): PromptBundle {
  const fail = (message: string): never => {
    throw new PromptConfigError(`${source}: ${message}`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("必须是 JSON 对象");
  const root = raw as Record<string, unknown>;
  const unknownRoot = Object.keys(root).filter((key) => key !== "version" && key !== "sections");
  if (unknownRoot.length > 0) fail(`未知键 ${unknownRoot.join(", ")}；允许 version、sections`);
  if (root.version !== PROMPT_VERSION) {
    fail(`version 必须是 ${PROMPT_VERSION}，收到 ${JSON.stringify(root.version)}`);
  }
  if (typeof root.sections !== "object" || root.sections === null || Array.isArray(root.sections)) {
    fail("sections 必须是对象");
  }

  const sections: Record<PromptSectionKey, string> = { ...BUILTIN_TEXT };
  const overrides: PromptSectionKey[] = [];
  for (const [key, value] of Object.entries(root.sections as Record<string, unknown>)) {
    if (!isSectionKey(key)) fail(`未知段落键 ${key}；允许 ${PROMPT_SECTIONS.join(", ")}`);
    if (typeof value !== "string" || value.trim() === "") fail(`段落 ${key} 必须是非空字符串`);
    const text = value as string;
    validatePlaceholders(key as PromptSectionKey, text, fail);
    sections[key as PromptSectionKey] = text;
    overrides.push(key as PromptSectionKey);
  }
  return {
    version: PROMPT_VERSION,
    sections,
    overrides: PROMPT_SECTIONS.filter((key) => overrides.includes(key)),
    source,
  };
}

function validatePlaceholders(
  key: PromptSectionKey,
  text: string,
  fail: (message: string) => never,
): void {
  const names = [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string);
  const unknown = names.filter((name) => !(PLACEHOLDERS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    fail(`段落 ${key} 含未知占位符 {{${unknown[0]}}}；允许 ${PLACEHOLDERS.map((n) => `{{${n}}}`).join("、")}`);
  }
  const required = REQUIRED_PLACEHOLDER[key];
  if (required && !names.includes(required)) {
    fail(`段落 ${key} 必须包含 {{${required}}}，否则任务数据会丢失`);
  }
}

function isSectionKey(key: string): key is PromptSectionKey {
  return (PROMPT_SECTIONS as readonly string[]).includes(key);
}

export interface PromptVars {
  taskId: string;
  repo?: string;
  prompt: string;
  context?: string | null;
}

/** 按固定顺序拼接段落；resume 只在恢复任务时出现，context 只在有上下文时出现 */
export function renderPrompt(
  bundle: PromptBundle,
  vars: PromptVars,
  opts: { resume?: boolean } = {},
): string {
  const values: Record<PromptPlaceholder, string> = {
    taskId: vars.taskId,
    repo: vars.repo ?? "",
    prompt: vars.prompt,
    context: vars.context ?? "",
  };
  const blocks: string[] = [];
  for (const key of PROMPT_SECTIONS) {
    if (key === "resume" && !opts.resume) continue;
    if (key === "context" && !vars.context) continue;
    const template = bundle.sections[key].trim();
    if (!template) continue;
    blocks.push(template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
      return (PLACEHOLDERS as readonly string[]).includes(name) ? values[name as PromptPlaceholder] : match;
    }));
  }
  return blocks.join("\n\n");
}

export function buildPrompt(
  task: Task,
  opts: { resume?: boolean; prompts?: PromptBundle } = {},
): string {
  return renderPrompt(
    opts.prompts ?? BUILTIN_PROMPTS,
    { taskId: task.id, repo: task.repo, prompt: task.prompt, context: task.context },
    { resume: opts.resume },
  );
}

/** 人读的概览：版本、覆盖来源、段落顺序；有覆盖时附带逐段 diff */
export function formatPromptReport(bundle: PromptBundle): string {
  const lines = [
    `提示词版本：${bundle.version}`,
    `覆盖文件：${bundle.source ?? "无（全部内置）"}`,
    `覆盖段落：${bundle.overrides.length > 0 ? bundle.overrides.join("、") : "无"}`,
    `段落顺序：${PROMPT_SECTIONS.join(" · ")}`,
  ];
  if (bundle.overrides.length > 0) lines.push("", formatPromptDiff(bundle));
  return lines.join("\n");
}

/** 逐段 diff：`-` 内置，`+` 覆盖 */
export function formatPromptDiff(bundle: PromptBundle): string {
  if (bundle.overrides.length === 0) return "没有覆盖，全部使用内置提示词。";
  const out: string[] = [];
  for (const key of bundle.overrides) {
    out.push(`--- 内置/${key}`, `+++ 覆盖/${key}`);
    const before = BUILTIN_TEXT[key].trim().split("\n");
    const after = bundle.sections[key].trim().split("\n");
    for (const line of diffLines(before, after)) out.push(`${line.sign}${line.text}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

interface DiffLine {
  sign: " " | "-" | "+";
  text: string;
}

/** 行级 LCS diff；提示词段落都很短，二维表足够 */
function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ sign: " ", text: before[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ sign: "-", text: before[i]! });
      i += 1;
    } else {
      out.push({ sign: "+", text: after[j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ sign: "-", text: before[i++]! });
  while (j < m) out.push({ sign: "+", text: after[j++]! });
  return out;
}
