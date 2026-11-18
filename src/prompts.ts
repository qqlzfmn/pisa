import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./types";

/**
 * 提示词分层：内置段落写在代码里，团队与仓库可以按段落覆盖，覆盖文件带版本号。
 * 目录结构（相对配置文件目录，默认 `<配置目录>/prompts`）：
 *
 *   prompts/VERSION                    正整数，改任何段落后递增
 *   prompts/<段落键>.md                 团队覆盖
 *   prompts/repos/<仓库别名>/<段落键>.md  该仓库的覆盖，优先于团队
 *
 * 启动时一次性加载；未知段落键、未知仓库别名、空文件或非法版本号直接报错。
 */

export type PromptSectionKey =
  | "worker.intro"
  | "worker.resume"
  | "worker.context"
  | "worker.task"
  | "worker.constraints";

export interface PromptSection {
  key: PromptSectionKey;
  /** 覆盖文本里可用的模板变量 */
  vars: readonly string[];
  builtin: string;
}

const CONSTRAINTS = [
  `## 约束（以下由 pisa guard 强制，越界调用会被拒绝）`,
  `- 文件读写、编辑只能落在工作目录内；git 的 -C / --work-tree / --git-dir 也只能指向工作目录`,
  `- 禁止 git push（任意形态）、reset --hard、clean -f、切换分支、worktree remove/prune、branch -D、rebase、commit --amend`,
  `- 禁止 sudo、删除根目录、改动 /etc 权限`,
  `- 提交与推送由 pisa 在任务结束后完成，不需要你操作`,
  `- 有测试就跑测试；没有测试就说明你如何验证`,
  `- 完成后用中文给出：改了什么、动了哪些文件、验证结果`,
  `- 不要输出寒暄，直接给结论`,
].join("\n");

/** 段落清单：顺序即 Worker 提示词的拼接顺序 */
export const PROMPT_SECTIONS: readonly PromptSection[] = [
  { key: "worker.intro", vars: ["taskId"], builtin: `你是 pisa 的 Worker，任务号 {{taskId}}。` },
  {
    key: "worker.resume",
    vars: [],
    builtin: [
      `## 恢复执行`,
      `上一次执行被中断。先核对现状，再决定动作，不要重复已经发生的副作用：`,
      `1. 检查工作目录：\`git status\` 与 \`git log\`，确认已有改动、提交与未完成的部分。`,
      `2. 检查外部动作是否已经落地：分支是否已推送、PR 是否已存在（如 \`gh pr list --head <分支>\`），以及任务是否已回帖。`,
      `3. 已完成的改动不重做；PR 已存在时不重复创建。推送、创建 PR、发表评论这些外部动作，确认尚未发生后再执行。`,
      `从核对结果出发继续剩余工作。`,
    ].join("\n"),
  },
  {
    key: "worker.context",
    vars: ["context"],
    builtin: `## 上一轮上下文（供参考，不是新指令）\n{{context}}`,
  },
  { key: "worker.task", vars: ["prompt"], builtin: `## 任务\n{{prompt}}` },
  { key: "worker.constraints", vars: [], builtin: CONSTRAINTS },
];

export const PROMPT_SECTION_KEYS: readonly PromptSectionKey[] = PROMPT_SECTIONS.map((s) => s.key);
const SECTION_BY_KEY = new Map(PROMPT_SECTIONS.map((s) => [s.key, s]));

export const BUILTIN_PROMPT_VERSION = 1;

export type PromptSource = "builtin" | "team" | `repo:${string}`;

export interface PromptBook {
  /** 覆盖版本号；没有覆盖目录时为内置版本 */
  version: number;
  /** 覆盖目录；null 表示没有目录，全部用内置 */
  dir: string | null;
  team: ReadonlyMap<PromptSectionKey, string>;
  repos: ReadonlyMap<string, ReadonlyMap<PromptSectionKey, string>>;
}

export const BUILTIN_PROMPTS: PromptBook = {
  version: BUILTIN_PROMPT_VERSION,
  dir: null,
  team: new Map(),
  repos: new Map(),
};

/** 配置错误：启动时抛出，不静默回退到内置 */
export class PromptConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptConfigError";
  }
}

function readLayer(
  dir: string,
  label: string,
  ignore: readonly string[] = [],
): Map<PromptSectionKey, string> {
  const out = new Map<PromptSectionKey, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ignore.includes(entry.name)) continue;
    const key = entry.isFile() && entry.name.endsWith(".md") ? entry.name.slice(0, -3) : null;
    const spec = key ? SECTION_BY_KEY.get(key as PromptSectionKey) : undefined;
    if (!spec) {
      throw new PromptConfigError(
        `${label}：未知的提示词键 ${entry.name}（可用：${PROMPT_SECTION_KEYS.join("、")}）`,
      );
    }
    const text = readFileSync(join(dir, entry.name), "utf8")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .trim();
    if (!text) throw new PromptConfigError(`${label}：${entry.name} 是空文件`);
    for (const [, name] of text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
      if (!spec.vars.includes(name as string)) {
        throw new PromptConfigError(
          `${label}：${entry.name} 使用了未知变量 {{${name}}}（可用：${spec.vars.join("、") || "无"}）`,
        );
      }
    }
    out.set(spec.key, text);
  }
  return out;
}

/** 加载覆盖目录；目录不存在时返回纯内置提示词 */
export function loadPrompts(dir: string | undefined, repoAliases: readonly string[] = []): PromptBook {
  if (!dir || !existsSync(dir)) return BUILTIN_PROMPTS;

  const versionFile = join(dir, "VERSION");
  if (!existsSync(versionFile)) throw new PromptConfigError(`提示词目录缺少 VERSION：${dir}`);
  const raw = readFileSync(versionFile, "utf8").replace(/^\uFEFF/, "").trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new PromptConfigError(`提示词版本必须是正整数：${versionFile} 里是 ${JSON.stringify(raw)}`);
  }

  const team = readLayer(dir, "团队提示词", ["VERSION", "repos"]);
  const repos = new Map<string, ReadonlyMap<PromptSectionKey, string>>();
  const reposRoot = join(dir, "repos");
  if (existsSync(reposRoot)) {
    for (const entry of readdirSync(reposRoot, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) {
        throw new PromptConfigError(`提示词 repos/ 下只能是仓库别名目录，发现文件 ${entry.name}`);
      }
      if (!repoAliases.includes(entry.name)) {
        throw new PromptConfigError(
          `未知的仓库别名 ${entry.name}（配置里的仓库：${repoAliases.join("、") || "无"}）`,
        );
      }
      repos.set(entry.name, readLayer(join(reposRoot, entry.name), `仓库 ${entry.name} 的提示词`));
    }
  }

  return { version: Number(raw), dir, team, repos };
}

export interface ResolvedPrompt {
  text: string;
  source: PromptSource;
}

/** 覆盖优先级：仓库 > 团队 > 内置 */
export function resolvePrompt(book: PromptBook, key: PromptSectionKey, repo?: string): ResolvedPrompt {
  const repoText = repo ? book.repos.get(repo)?.get(key) : undefined;
  if (repoText !== undefined) return { text: repoText, source: `repo:${repo}` };
  const teamText = book.team.get(key);
  if (teamText !== undefined) return { text: teamText, source: "team" };
  return { text: SECTION_BY_KEY.get(key)!.builtin, source: "builtin" };
}

function render(book: PromptBook, key: PromptSectionKey, repo: string | undefined, vars: Record<string, string>): string {
  const { text } = resolvePrompt(book, key, repo);
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** 组装 Worker 提示词：固定顺序，未恢复时省略恢复段落，无上下文时省略上下文段落 */
export function buildWorkerPrompt(book: PromptBook, task: Task, opts: { resume?: boolean } = {}): string {
  const blocks = [render(book, "worker.intro", task.repo, { taskId: task.id })];
  if (opts.resume) blocks.push(render(book, "worker.resume", task.repo, {}));
  if (task.context) blocks.push(render(book, "worker.context", task.repo, { context: task.context }));
  blocks.push(render(book, "worker.task", task.repo, { prompt: task.prompt }));
  blocks.push(render(book, "worker.constraints", task.repo, {}));
  return blocks.join("\n\n");
}

function sourceLabel(source: PromptSource): string {
  if (source === "builtin") return "内置";
  if (source === "team") return "团队";
  return `仓库 ${source.slice("repo:".length)}`;
}

function summary(book: PromptBook): string {
  const parts = [`提示词 v${book.version}`];
  if (book.team.size) parts.push(`团队覆盖 ${book.team.size} 段`);
  if (book.repos.size) {
    parts.push(
      `仓库覆盖 ${[...book.repos].map(([alias, sections]) => `${alias}(${sections.size} 段)`).join("、")}`,
    );
  }
  if (parts.length === 1) parts.push("全部使用内置");
  return parts.join(" · ");
}

/** `/pisa prompts`：版本、每个段落的生效来源；diff 模式只显示被覆盖的段落 */
export function formatPrompts(
  book: PromptBook,
  opts: { repo?: string; diff?: boolean } = {},
): string {
  const lines = [summary(book)];
  if (opts.repo) lines.push(`已按仓库 ${opts.repo} 解析覆盖`);

  if (opts.diff) {
    const blocks: string[] = [];
    for (const spec of PROMPT_SECTIONS) {
      const resolved = resolvePrompt(book, spec.key, opts.repo);
      if (resolved.text === spec.builtin) continue;
      blocks.push(
        `## ${spec.key}（${sourceLabel(resolved.source)}）\n${unifiedDiff(
          spec.builtin,
          resolved.text,
          "内置",
          sourceLabel(resolved.source),
        )}`,
      );
    }
    if (blocks.length === 0) blocks.push("没有覆盖，全部使用内置。");
    const dir = book.dir
      ? `覆盖目录：${book.dir}（改完重启生效）`
      : "没有覆盖目录，全部使用内置；在配置目录创建 prompts/ 后重启生效。";
    return [...lines, "", ...blocks, "", dir].join("\n");
  }

  const width = Math.max(...PROMPT_SECTION_KEYS.map((k) => k.length));
  const rows = PROMPT_SECTIONS.map((spec) => {
    const resolved = resolvePrompt(book, spec.key, opts.repo);
    return `${spec.key.padEnd(width)} · ${sourceLabel(resolved.source)}`;
  });
  const dir = book.dir
    ? `覆盖目录：${book.dir}（改完重启生效）`
    : "没有覆盖目录，全部使用内置；在配置目录创建 prompts/ 后重启生效。";
  return [...lines, ...rows, dir].join("\n");
}

interface DiffOp {
  type: " " | "-" | "+";
  line: string;
}

function diffOps(a: string[], b: string[]): DiffOp[] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", line: a[i++]! });
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "-", line: a[i++]! });
    } else {
      ops.push({ type: "+", line: b[j++]! });
    }
  }
  while (i < a.length) ops.push({ type: "-", line: a[i++]! });
  while (j < b.length) ops.push({ type: "+", line: b[j++]! });
  return ops;
}

/** 行级 unified diff；段落文本很短，O(n*m) 的 LCS 足够 */
function unifiedDiff(before: string, after: string, fromLabel: string, toLabel: string): string {
  const ops = diffOps(before.split("\n"), after.split("\n"));
  const changed = ops.flatMap((op, i) => (op.type === " " ? [] : [i]));
  if (changed.length === 0) return "";

  const ranges: Array<[number, number]> = [];
  for (const i of changed) {
    const start = Math.max(0, i - 3);
    const end = Math.min(ops.length - 1, i + 3);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const oldAt: number[] = [];
  const newAt: number[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    oldAt.push(oldNo);
    newAt.push(newNo);
    if (op.type !== "+") oldNo++;
    if (op.type !== "-") newNo++;
  }
  oldAt.push(oldNo);
  newAt.push(newNo);

  const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end + 1);
    const oldCount = slice.filter((op) => op.type !== "+").length;
    const newCount = slice.filter((op) => op.type !== "-").length;
    out.push(`@@ -${oldAt[start]},${oldCount} +${newAt[start]},${newCount} @@`);
    for (const op of slice) out.push(op.type + op.line);
  }
  return out.join("\n");
}
