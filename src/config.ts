import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RepoConfig {
  alias: string;
  path: string;
  remote?: string;
  baseBranch?: string;
}

/** 一条定时任务：cron 到点后用 prompt 开单 */
export interface ScheduleJob {
  id: string;
  cron: string;
  prompt: string;
  repo?: string;
  enabled?: boolean;
}

/** 一个被监听的 GitHub 仓库；chatId / userId 决定评论产生的任务归属 */
export interface GithubRepoConfig {
  repo: string;
  chatId: string;
  userId: string;
}

export interface GithubConfig {
  enabled: boolean;
  /** 单仓库旧写法；repos 非空时被忽略 */
  repo?: string;
  intervalSec?: number;
  tokenEnv?: string;
  /** 单仓库旧写法：任务归属 */
  chatId?: string;
  userId?: string;
  /** 多仓库写法，优先于旧字段 */
  repos?: GithubRepoConfig[];
}

export interface Config {
  trigger: string;
  /** 私聊里不带触发词也当成任务 */
  dmWithoutTrigger: boolean;
  whitelist: { users: string[]; repos: string[] };
  repos: RepoConfig[];
  worker: {
    adapter: string;
    command: string;
    timeoutSec: number;
    /** /pisa merge 验证命令的超时（秒）；默认 600 */
    verifyTimeoutSec: number;
    extraArgs: string[];
    concurrency: number;
  };
  delivery: { push: boolean; pr: boolean; commitName: string; commitEmail: string };
  channels: { cli?: boolean; telegram?: { enabled: boolean; tokenEnv: string; proxy?: string } };
  webhook?: { enabled: boolean; port: number; tokenEnv: string; chatId: string; userId: string };
  /** 评论 → 任务 → 回帖；repo 形如 owner/repo */
  github?: GithubConfig;
  /** 定时任务的发送方身份；缺省时 schedules 不生效 */
  scheduler?: { chatId: string; userId: string };
  schedules?: ScheduleJob[];
  proactive?: {
    keywords?: { enabled: boolean; words: string[]; cooldownSec?: number; chatId?: string; userId?: string; prompt?: string };
    probe?: {
      enabled: boolean;
      command: string;
      intervalSec?: number;
      cooldownSec?: number;
      chatId: string;
      userId: string;
      repo?: string;
      prompt?: string;
    };
  };
  stateDir: string;
}

export const DEFAULT_CONFIG: Config = {
  trigger: "/pisa",
  dmWithoutTrigger: true,
  whitelist: { users: [], repos: [] },
  repos: [],
  worker: { adapter: "omp", command: "omp", timeoutSec: 3600, verifyTimeoutSec: 600, extraArgs: [], concurrency: 2 },
  delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
  channels: { cli: true, telegram: { enabled: false, tokenEnv: "PISA_TELEGRAM_TOKEN", proxy: process.env.PISA_TELEGRAM_PROXY } },
  stateDir: ".pisa",
};

function merge(base: Config, patch: Partial<Config>): Config {
  return {
    ...base,
    ...patch,
    whitelist: { ...base.whitelist, ...(patch.whitelist ?? {}) },
    worker: { ...base.worker, ...(patch.worker ?? {}) },
    delivery: { ...base.delivery, ...(patch.delivery ?? {}) },
    channels: { ...base.channels, ...(patch.channels ?? {}) },
  };
}

export function loadConfig(path = process.env.PISA_CONFIG ?? "pisa.config.json"): Config {
  const abs = resolve(path);
  let cfg = DEFAULT_CONFIG;
  if (existsSync(abs)) {
    cfg = merge(DEFAULT_CONFIG, JSON.parse(readFileSync(abs, "utf8")) as Partial<Config>);
  }
  // 环境变量覆盖，便于容器与测试
  if (process.env.PISA_TRIGGER) cfg.trigger = process.env.PISA_TRIGGER;
  if (process.env.PISA_USERS) cfg.whitelist.users = process.env.PISA_USERS.split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.PISA_STATE_DIR) cfg.stateDir = process.env.PISA_STATE_DIR;
  return cfg;
}

export function repoByAlias(cfg: Config, alias?: string): RepoConfig | undefined {
  if (!alias) return cfg.repos[0];
  return cfg.repos.find((r) => r.alias === alias);
}

/**
 * 被监听的 GitHub 仓库清单：repos 优先，否则旧的 repo/chatId/userId 组成单元素数组。
 * 缺少归属身份的条目直接丢弃，避免投递出没有 chat 的任务。
 */
export function githubRepos(gh?: GithubConfig): GithubRepoConfig[] {
  if (!gh) return [];
  if (gh.repos && gh.repos.length > 0) {
    return gh.repos.filter((r) => Boolean(r.repo && r.chatId && r.userId));
  }
  if (gh.repo && gh.chatId && gh.userId) return [{ repo: gh.repo, chatId: gh.chatId, userId: gh.userId }];
  return [];
}

const REPO_ALIAS_PREFIX = /^@([A-Za-z0-9_-]+)\s+([\s\S]+)$/;

/**
 * IM 仓库前缀：`@别名 正文`。
 * 别名必须精确存在于配置中；不存在或没有正文时返回 null，调用方保持原文不动。
 */
export function splitRepoAlias(text: string, repos: RepoConfig[]): { alias: string; body: string } | null {
  const m = REPO_ALIAS_PREFIX.exec(text.trim());
  if (!m) return null;
  const alias = m[1]!;
  if (!repos.some((r) => r.alias === alias)) return null;
  return { alias, body: m[2]!.trim() };
}

export type CommandKind =
  | "cancel"
  | "help"
  | "status"
  | "schedules"
  | "continue"
  | "merge"
  | "resume"
  | "rewind"
  | "confirm";

export interface CommandSpec {
  /** 英文命令名：精确匹配、模糊提示与 Telegram 菜单都用它 */
  command: CommandKind;
  /** 中文别名，只参与精确匹配 */
  alias?: string;
  description: string;
  /** 是否注册到 Telegram 命令菜单 */
  menu?: boolean;
}

/** 命令清单：解析、错拼建议、菜单注册的唯一事实源 */
export const COMMANDS: readonly CommandSpec[] = [
  { command: "cancel", alias: "取消", description: "取消任务", menu: true },
  { command: "help", alias: "帮助", description: "查看命令帮助", menu: true },
  { command: "status", alias: "状态", description: "查看任务看板", menu: true },
  { command: "schedules", alias: "定时", description: "查看定时任务", menu: true },
  { command: "continue", alias: "继续", description: "接着上一轮分支继续", menu: true },
  { command: "merge", alias: "合并", description: "把已完成任务合入主干", menu: true },
  { command: "resume", alias: "恢复", description: "恢复被中断的任务", menu: true },
  { command: "rewind", alias: "撤销", description: "预览并撤销任务副作用", menu: true },
  { command: "confirm", alias: "确认", description: "确认被拦下的单英文词任务", menu: false },
];

/** Telegram setMyCommands 的载荷：只列用户主动使用的命令 */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = COMMANDS.filter(
  (c) => c.menu,
).map(({ command, description }) => ({ command, description }));

const KIND_BY_WORD: Record<string, CommandKind> = {};
for (const c of COMMANDS) {
  KIND_BY_WORD[c.command] = c.command;
  if (c.alias) KIND_BY_WORD[c.alias] = c.command;
}

/** 带参数的命令；其余命令忽略参数（与改造前一致） */
const TAKES_BODY: Partial<Record<CommandKind, true>> = {
  cancel: true,
  continue: true,
  merge: true,
  resume: true,
  rewind: true,
};

export interface ParsedCommand {
  kind: CommandKind | "task";
  body: string;
}

/** 触发词解析：仅接受以 trigger 开头的文本 */
export function parseCommand(text: string, trigger: string): ParsedCommand | null {
  const t = text.trim();
  if (!t.startsWith(trigger)) return null;
  const rest = t.slice(trigger.length).trim();
  if (!rest) return { kind: "help", body: "" };
  const [head, ...tail] = rest.split(/\s+/);
  const kind = KIND_BY_WORD[head!];
  if (!kind) return { kind: "task", body: rest };
  return { kind, body: TAKES_BODY[kind] ? tail.join(" ").trim() : "" };
}

/** 单个 ASCII 词：像命令、不像需求正文 */
const SINGLE_ASCII_WORD = /^[A-Za-z][A-Za-z0-9_-]*$/;

export type TaskGuard =
  | { kind: "suggest"; command: CommandKind }
  | { kind: "confirm" };

/**
 * 任务正文的误触防护：单个 ASCII 词不直接建任务。
 * 与菜单命令编辑距离 ≤ 2 视为打错命令，返回建议；其余单词要求确认。
 * 中文与多词正文返回 null，行为不变。
 */
export function taskGuard(body: string): TaskGuard | null {
  const word = body.trim();
  if (!SINGLE_ASCII_WORD.test(word)) return null;
  const lower = word.toLowerCase();
  let best: { command: CommandKind; distance: number } | null = null;
  for (const c of COMMANDS) {
    if (!c.menu) continue;
    const distance = editDistance(lower, c.command);
    if (distance <= 2 && (!best || distance < best.distance)) best = { command: c.command, distance };
  }
  return best ? { kind: "suggest", command: best.command } : { kind: "confirm" };
}

/** Levenshtein 距离：命令名都很短，二维滚动数组足够 */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}
