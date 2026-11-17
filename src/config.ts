import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RepoConfig {
  alias: string;
  path: string;
  remote?: string;
  baseBranch?: string;
}

export interface Config {
  trigger: string;
  /** 私聊里不带触发词也当成任务 */
  dmWithoutTrigger: boolean;
  whitelist: { users: string[]; repos: string[] };
  repos: RepoConfig[];
  worker: { command: string; timeoutSec: number; extraArgs: string[]; concurrency: number };
  delivery: { push: boolean; pr: boolean; commitName: string; commitEmail: string };
  channels: { cli?: boolean; telegram?: { enabled: boolean; tokenEnv: string; proxy?: string } };
  webhook?: { enabled: boolean; port: number; tokenEnv: string; chatId: string; userId: string };
  stateDir: string;
}

export const DEFAULT_CONFIG: Config = {
  trigger: "/pisa",
  dmWithoutTrigger: true,
  whitelist: { users: [], repos: [] },
  repos: [],
  worker: { command: "omp", timeoutSec: 3600, extraArgs: [], concurrency: 2 },
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

/** 触发词解析：仅接受以 trigger 开头的文本 */
export function parseCommand(text: string, trigger: string): { kind: "task" | "cancel" | "help" | "status" | "continue" | "merge"; body: string } | null {
  const t = text.trim();
  if (!t.startsWith(trigger)) return null;
  const rest = t.slice(trigger.length).trim();
  if (!rest) return { kind: "help", body: "" };
  const [head, ...tail] = rest.split(/\s+/);
  if (head === "cancel" || head === "取消") return { kind: "cancel", body: tail.join(" ").trim() };
  if (head === "help" || head === "帮助") return { kind: "help", body: "" };
  if (head === "status" || head === "状态") return { kind: "status", body: "" };
  if (head === "continue" || head === "继续") return { kind: "continue", body: tail.join(" ").trim() };
  if (head === "merge" || head === "合并") return { kind: "merge", body: tail.join(" ").trim() };
  return { kind: "task", body: rest };
}
