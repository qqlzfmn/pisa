import type { ApiTarget } from "./api-client";
import type { TaskStatus } from "./types";

/**
 * 退出码：脚本据此分支，语义固定。
 * 0 正常 / 1 需重启（守护进程没起来或心跳过期）/ 2 部件错误（任务失败、接口 5xx）
 * 3 待配置（配置、白名单、鉴权）/ 4 用法 / 5 找不到 / 6 不可运行 / 7 等待超时
 */
export const EXIT = {
  ok: 0,
  restart: 1,
  component: 2,
  config: 3,
  usage: 4,
  notFound: 5,
  notRunnable: 6,
  timeout: 7,
} as const;

export const STATUSES: readonly TaskStatus[] = ["queued", "running", "paused", "succeeded", "failed", "cancelled", "rewound"];
export const TERMINAL: readonly TaskStatus[] = ["succeeded", "failed", "cancelled", "rewound"];

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  /** 管理接口地址；缺省读 stateDir/api.json */
  api?: ApiTarget;
}

export const defaultIo: Io = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
};

export class UsageError extends Error {}
export class NotFoundError extends Error {}
export class NotRunnableError extends Error {}
export class ConfigError extends Error {}
export class RestartError extends Error {}

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOL_FLAGS = new Set(["json", "wait", "help", "yes"]);
const VALUE_FLAGS = new Set([
  "config",
  "repo",
  "event-id",
  "requester",
  "timeout",
  "interval",
  "status",
  "limit",
  "pr",
  "github-repo",
  "tail",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOL_FLAGS.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} 不接受取值`);
      flags.set(name, true);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`未知选项 --${name}`);
    const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} 缺少取值`);
    flags.set(name, value);
  }
  return { positional, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} 需要数字，收到 ${raw}`);
  return Math.floor(n);
}

export function json(io: Io, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

