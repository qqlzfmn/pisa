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

export interface Config {
  trigger: string;
  /** 私聊里不带触发词也当成任务 */
  dmWithoutTrigger: boolean;
  whitelist: { users: string[]; repos: string[] };
  repos: RepoConfig[];
  worker: { adapter: string; command: string; timeoutSec: number; extraArgs: string[]; concurrency: number };
  delivery: { push: boolean; pr: boolean; commitName: string; commitEmail: string };
  channels: { cli?: boolean; telegram?: { enabled: boolean; tokenEnv: string; proxy?: string } };
  webhook?: { enabled: boolean; port: number; tokenEnv: string; chatId: string; userId: string };
  /** PR 评论 → 任务 → 回帖；repo 形如 owner/repo */
  github?: { enabled: boolean; repo: string; intervalSec?: number; tokenEnv?: string; chatId: string; userId: string };
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
  worker: { adapter: "omp", command: "omp", timeoutSec: 3600, extraArgs: [], concurrency: 2 },
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

/** 触发词解析：仅接受以 trigger 开头的文本 */
export function parseCommand(
  text: string,
  trigger: string,
): { kind: "task" | "cancel" | "help" | "status" | "continue" | "merge" | "resume" | "schedules"; body: string } | null {
  const t = text.trim();
  if (!t.startsWith(trigger)) return null;
  const rest = t.slice(trigger.length).trim();
  if (!rest) return { kind: "help", body: "" };
  const [head, ...tail] = rest.split(/\s+/);
  if (head === "cancel" || head === "取消") return { kind: "cancel", body: tail.join(" ").trim() };
  if (head === "help" || head === "帮助") return { kind: "help", body: "" };
  if (head === "status" || head === "状态") return { kind: "status", body: "" };
  if (head === "schedules" || head === "定时") return { kind: "schedules", body: "" };
  if (head === "continue" || head === "继续") return { kind: "continue", body: tail.join(" ").trim() };
  if (head === "merge" || head === "合并") return { kind: "merge", body: tail.join(" ").trim() };
  if (head === "resume" || head === "恢复") return { kind: "resume", body: tail.join(" ").trim() };
  return { kind: "task", body: rest };
}
