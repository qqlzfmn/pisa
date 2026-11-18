import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

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

/** 本机 Web 控制台；只监听 127.0.0.1，token 是唯一的鉴权因子 */
export interface WebConfig {
  enabled: boolean;
  port: number;
  /** token 所在的环境变量名 */
  tokenEnv: string;
  /** 页面派活与操作使用的身份；必须在 whitelist.users 里 */
  userId: string;
  chatId: string;
}

/** 外部事件入口；只监听 127.0.0.1，凭据全部来自环境变量 */
export interface TriggersConfig {
  enabled: boolean;
  port: number;
  githubActions?: {
    enabled: boolean;
    /** webhook secret 所在的环境变量名 */
    secretEnv: string;
    chatId: string;
    userId: string;
    repo?: string;
    /** owner/name 白名单；空表示不限制 */
    repos?: string[];
    /** 订阅的 X-GitHub-Event，默认 ["workflow_run"] */
    events?: string[];
    /** 默认 true：只把失败的运行变成任务 */
    failedOnly?: boolean;
    /** 覆盖默认正文模板 */
    prompt?: string;
  };
  feishu?: {
    enabled: boolean;
    verificationTokenEnv?: string;
    encryptKeyEnv?: string;
    chats?: string[];
    users?: string[];
    chatId: string;
    userId: string;
    repo?: string;
  };
  wecom?: {
    enabled: boolean;
    tokenEnv: string;
    aesKeyEnv: string;
    corpId: string;
    users?: string[];
    chatId: string;
    userId: string;
    repo?: string;
  };
}

/** events 与 progress 的默认保留天数 */
export const DEFAULT_RETENTION_DAYS = 30;

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
    extraArgs: string[];
    concurrency: number;
    /** Worker 子进程从 process.env 继承的变量白名单；缺省见 DEFAULT_ENV_ALLOW */
    envAllow?: string[];
    /** 多久没有任何输出/进度就算卡死并杀掉，默认 900 秒 */
    idleTimeoutSec?: number;
  };
  delivery: { push: boolean; pr: boolean; commitName: string; commitEmail: string };
  /** 通知详细程度；progress=false 时只发接单/执行/完成等生命周期消息 */
  notifications?: { progress?: boolean };
  channels: { cli?: boolean; telegram?: { enabled: boolean; tokenEnv: string; proxy?: string } };
  /** 本机 Web 控制台；缺省值见 DEFAULT_WEB */
  web?: WebConfig;
  webhook?: { enabled: boolean; port: number; tokenEnv: string; chatId: string; userId: string };
  /** GitHub Actions、飞书、企业微信的事件入口；缺省关闭 */
  triggers?: TriggersConfig;
  /** 评论 → 任务 → 回帖；repo 形如 owner/repo */
  github?: GithubConfig;
  /** 定时任务的发送方身份；缺省时 schedules 不生效 */
  scheduler?: { chatId: string; userId: string };
  schedules?: ScheduleJob[];
  /** events 与 progress 的保留天数；≤ 0 关闭每日清理，默认 30 */
  retentionDays?: number;
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

/**
 * Worker 子进程默认继承的环境变量：只够进程本身跑起来。
 * 凭据（PISA_TELEGRAM_TOKEN、GH_TOKEN、厂商 key）不在白名单内，需要时显式加进 worker.envAllow。
 */
export const DEFAULT_ENV_ALLOW: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "SHELL",
  "USER",
];

/** Web 控制台默认值：默认关闭，`bun run web` 用 `--web` 强制开启 */
export const DEFAULT_WEB: WebConfig = {
  enabled: false,
  port: 8787,
  tokenEnv: "PISA_WEB_TOKEN",
  userId: process.env.PISA_CLI_USER ?? process.env.USER ?? "web",
  chatId: "web",
};

export const DEFAULT_CONFIG: Config = {
  trigger: "/pisa",
  dmWithoutTrigger: true,
  whitelist: { users: [], repos: [] },
  repos: [],
  worker: {
    adapter: "omp",
    command: "omp",
    timeoutSec: 3600,
    extraArgs: [],
    concurrency: 2,
    envAllow: [...DEFAULT_ENV_ALLOW],
    idleTimeoutSec: 900,
  },
  delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
  notifications: { progress: false },
  channels: { cli: true, telegram: { enabled: false, tokenEnv: "PISA_TELEGRAM_TOKEN", proxy: process.env.PISA_TELEGRAM_PROXY } },
  web: DEFAULT_WEB,
  retentionDays: DEFAULT_RETENTION_DAYS,
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
    web: { ...(base.web ?? DEFAULT_WEB), ...(patch.web ?? {}) },
  };
}

export function loadConfig(path = process.env.PISA_CONFIG ?? "pisa.config.json"): Config {
  const abs = resolve(path);
  const baseDir = dirname(abs);
  let cfg = DEFAULT_CONFIG;
  if (existsSync(abs)) {
    cfg = merge(DEFAULT_CONFIG, JSON.parse(readFileSync(abs, "utf8")) as Partial<Config>);
  }
  // 相对路径以配置文件所在目录为基准：守护进程与 CLI 从不同工作目录启动时指向同一份状态
  if (!isAbsolute(cfg.stateDir)) cfg.stateDir = resolve(baseDir, cfg.stateDir);
  cfg = {
    ...cfg,
    repos: cfg.repos.map((r) => ({
      ...r,
      path: typeof r.path === "string" && !isAbsolute(r.path) ? resolve(baseDir, r.path) : r.path,
    })),
  };
  // 环境变量覆盖，便于容器与测试
  if (process.env.PISA_TRIGGER) cfg.trigger = process.env.PISA_TRIGGER;
  if (process.env.PISA_USERS) cfg.whitelist.users = process.env.PISA_USERS.split(",").map((s) => s.trim()).filter(Boolean);
  if (process.env.PISA_STATE_DIR) cfg.stateDir = resolve(process.env.PISA_STATE_DIR);
  return cfg;
}

/** 从 start 向上查找配置文件；找不到时回落到 start 下的默认文件名 */
export function findConfig(start = process.cwd(), name = "pisa.config.json"): string {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start, name);
    dir = parent;
  }
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
  | "examples"
  | "continue"
  | "merge"
  | "resume"
  | "rewind"
  | "confirm"
  | "verbose";

/** 帮助分组：派活（新任务与续跑）、查询（状态与用法）、维护（改撤合）、集成（不经 IM 的入口） */
export type HelpGroup = "派活" | "查询" | "维护" | "集成";

export interface CommandSpec {
  /** 英文命令名：精确匹配、模糊提示与 Telegram 菜单都用它 */
  command: CommandKind;
  /** 中文别名，只参与精确匹配 */
  alias?: string;
  description: string;
  /** 参数提示；有值的命令接收正文，也是帮助里的用法后缀 */
  args?: string;
  /** 帮助分组；帮助里只列有分组的命令 */
  group?: HelpGroup;
  /** 是否注册到 Telegram 命令菜单 */
  menu?: boolean;
}

/** 命令清单：解析、错拼建议、菜单注册与帮助分组的唯一事实源 */
export const COMMANDS: readonly CommandSpec[] = [
  { command: "continue", alias: "继续", description: "接着上一轮分支继续", args: "<任务号> <新要求>", group: "派活", menu: true },
  { command: "confirm", alias: "确认", description: "确认被拦下的单英文词任务", group: "派活", menu: false },
  { command: "status", alias: "状态", description: "查看任务看板", group: "查询", menu: true },
  { command: "schedules", alias: "定时", description: "查看定时任务", group: "查询", menu: true },
  { command: "examples", alias: "示例", description: "查看可直接照抄的场景", group: "查询", menu: true },
  { command: "verbose", alias: "进度", description: "过程消息开关（on/off）", args: "[on|off]", group: "查询", menu: true },
  { command: "help", alias: "帮助", description: "查看命令帮助", group: "查询", menu: true },
  { command: "cancel", alias: "取消", description: "取消任务", args: "[任务号]", group: "维护", menu: true },
  { command: "resume", alias: "恢复", description: "恢复被中断的任务", args: "<任务号>", group: "维护", menu: true },
  { command: "rewind", alias: "撤销", description: "预览任务副作用，--yes 执行撤销", args: "<任务号> [--yes]", group: "维护", menu: true },
  { command: "merge", alias: "合并", description: "验证后把已完成任务合入主干", args: "<任务号>", group: "维护", menu: true },
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

/** 接收正文的命令：有参数提示即有正文，其余命令忽略参数（与改造前一致） */
const TAKES_BODY = new Set<CommandKind>(COMMANDS.filter((c) => c.args).map((c) => c.command));

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
  return { kind, body: TAKES_BODY.has(kind) ? tail.join(" ").trim() : "" };
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
