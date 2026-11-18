#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_WEB, findConfig, loadConfig, type Config } from "./config";
import type { TaskStatus } from "./types";
import { formatBoard, formatDuration, preview, type BoardView, type ExecutorState, type TaskJson } from "./status";

/**
 * 退出码：脚本据此分支，不要在版本间随意改语义。
 * 1 专指「改动已在磁盘上，需要重启进程才生效」。
 */
export const EXIT = {
  ok: 0,
  restart: 1,
  component: 2,
  config: 3,
} as const;

const STATUSES: readonly TaskStatus[] = ["queued", "running", "paused", "succeeded", "failed", "cancelled", "rewound"];
const TERMINAL: readonly TaskStatus[] = ["succeeded", "failed", "cancelled", "rewound"];

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
};

/** 配置缺失或 token 不可用：换值就能好，退出码 3 */
class ConfigError extends Error {}

/** 其余失败：任务失败、找不到、HTTP/网络错误、用法错误，退出码 2 */
class ComponentError extends Error {}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOL_FLAGS = new Set(["json", "wait", "help", "yes", "force"]);
const VALUE_FLAGS = new Set([
  "config",
  "repo",
  "event-id",
  "timeout",
  "interval",
  "status",
  "limit",
  "pr",
  "github-repo",
  "tail",
  "url",
]);

function parseArgs(argv: string[]): ParsedArgs {
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
      if (eq !== -1) throw new ComponentError(`--${name} 不接受取值`);
      flags.set(name, true);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new ComponentError(`未知选项 --${name}`);
    const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("--")) throw new ComponentError(`--${name} 缺少取值`);
    flags.set(name, value);
  }
  return { positional, flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ComponentError(`--${name} 需要数字，收到 ${raw}`);
  return Math.floor(n);
}

function printJson(io: Io, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

/** 响应投影：与 `/state`、`/tickets` 的 JSON 一一对应，CLI 只做展示 */
interface BoardTicket extends TaskJson {
  statusLabel: string;
}

interface EffectRow {
  kind: string;
  target: string | null;
  detail: string | null;
  createdAt: number;
}

interface StateResponse extends BoardView {
  ok: true;
  repos: string[];
  repo: string | null;
}

interface ListResponse {
  ok: true;
  tickets: BoardTicket[];
  total: number;
}

interface TicketResponse {
  ok: true;
  ticket: BoardTicket;
  effects: EffectRow[];
  logTail: string[];
}

interface SubmitResponse {
  ok: true;
  ticketId: string;
  ticket: BoardTicket;
  message: string;
}

interface RetryResponse extends SubmitResponse {
  retriedFrom: string;
}

interface LogsResponse {
  ok: true;
  id: string;
  lines: string[];
}

interface ActionResponse {
  ok: boolean;
  status: string | null;
  message: string;
}

interface MergeResponse extends ActionResponse {
  restartRequired: boolean;
}

interface RewindResponse extends ActionResponse {
  undone: boolean;
}

interface PauseResponse {
  ok: true;
  executor: ExecutorState;
}

interface Client {
  base: string;
  token: string;
  tokenEnv: string;
}

function resolveConfigPath(args: ParsedArgs): string {
  return flagString(args, "config") ?? process.env.PISA_CONFIG ?? findConfig(process.cwd());
}

function openConfig(args: ParsedArgs): Config {
  const configPath = resolveConfigPath(args);
  if (!existsSync(configPath)) {
    throw new ConfigError(`找不到配置文件：${configPath}；可用 --config 指定`);
  }
  try {
    return loadConfig(configPath);
  } catch (err) {
    throw new ConfigError(`配置文件不可用：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** token 与端口都来自 `pisa.config.json` 的 web 段，和守护进程读同一份 */
function resolveClient(args: ParsedArgs, cfg: Config): Client {
  const web = cfg.web ?? DEFAULT_WEB;
  const tokenEnv = web.tokenEnv;
  const token = process.env[tokenEnv]?.trim();
  if (!token) throw new ConfigError(`未设置管理 API token：请导出 ${tokenEnv}，值需与守护进程一致`);
  const base = (flagString(args, "url") ?? `http://127.0.0.1:${web.port}`).replace(/\/+$/, "");
  return { base, token, tokenEnv };
}

async function call<T>(client: Client, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${client.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${client.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ComponentError(
      `无法连接管理 API（${client.base}）：${reason}；确认守护进程在运行且配置里 web.enabled=true`,
    );
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { ok: false, error: text };
    }
  }
  if (!res.ok) {
    const data = (parsed ?? {}) as Record<string, unknown>;
    const message =
      typeof data.error === "string"
        ? data.error
        : typeof data.message === "string" && data.message
          ? data.message
          : `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) {
      throw new ConfigError(`管理 API 拒绝访问：token 不匹配（检查 ${client.tokenEnv}）`);
    }
    if (data.reason === "config") throw new ConfigError(message);
    throw new ComponentError(message);
  }
  return (parsed ?? {}) as T;
}

function queryOf(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

function needPositional(args: ParsedArgs, index: number, usage: string): string {
  const value = args.positional[index];
  if (!value) throw new ComponentError(`用法：${usage}`);
  return value;
}

function ticketHuman(io: Io, cfg: Config, ticket: BoardTicket): void {
  const rows: Array<[string, string]> = [
    ["任务", ticket.id],
    ["状态", ticket.status],
    ["阶段", `${ticket.stage}（${ticket.stageLabel}）`],
    ["仓库", ticket.repo],
    ["需求", preview(ticket.prompt, 120)],
    ["分支", ticket.branch ?? "(未创建)"],
    ["PR", ticket.prUrl ?? "(无)"],
    ["创建", new Date(ticket.createdAt).toISOString()],
    ["耗时", ticket.duration],
    ["日志", join(cfg.stateDir, "logs", `${ticket.id}.log`)],
  ];
  if (ticket.summary) rows.push(["摘要", ticket.summary]);
  if (ticket.error) rows.push(["错误", ticket.error]);
  for (const [k, v] of rows) io.out(`${k}：${v}`);
}

async function waitForTicket(io: Io, client: Client, args: ParsedArgs, id: string): Promise<number> {
  const timeoutSec = flagNumber(args, "timeout") ?? 1800;
  const intervalMs = Math.max(10, flagNumber(args, "interval") ?? 1000);
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const { ticket } = await call<TicketResponse>(client, "GET", `/tickets/${encodeURIComponent(id)}`);
    if (TERMINAL.includes(ticket.status)) {
      if (args.flags.get("json")) printJson(io, ticket);
      else {
        io.out(`${ticket.id} · ${ticket.status}`);
        if (ticket.summary) io.out(ticket.summary);
        if (ticket.error) io.err(ticket.error);
        if (ticket.prUrl) io.out(ticket.prUrl);
      }
      return ticket.status === "succeeded" ? EXIT.ok : EXIT.component;
    }
    if (ticket.status === "paused") {
      if (args.flags.get("json")) printJson(io, ticket);
      else io.err(`任务 ${ticket.id} 已暂停，恢复请在 pisa 会话里用 resume ${ticket.id}`);
      return EXIT.component;
    }
    if (Date.now() >= deadline) {
      if (args.flags.get("json")) printJson(io, { id: ticket.id, status: ticket.status, timeout: true });
      else io.err(`等待超时，任务仍在 ${ticket.status}：${ticket.id}`);
      return EXIT.component;
    }
    await Bun.sleep(intervalMs);
  }
}

export function helpText(): string {
  return `pisa CLI：本地 pisa 守护进程的管理客户端（只走 http://127.0.0.1）

用法：
  pisa run <需求> [--repo 别名] [--wait] [--json]        （task 同义）
  pisa continue <任务号> <新要求> [--wait] [--json]
  pisa retry <任务号> [--json]                           失败/取消后重跑
  pisa stop <任务号> [--json]                            （cancel 同义）
  pisa merge <任务号> [--force] [--json]                 成功后退出码 1
  pisa rewind <任务号> [--yes] [--json]
  pisa wait <任务号> [--timeout 秒] [--json]
  pisa status [--repo 别名] [--json]
  pisa list [--repo 别名] [--status 状态] [--limit N] [--pr 编号] [--json]
  pisa show <任务号> [--json]
  pisa logs <任务号> [--tail N] [--json]
  pisa pause | resume [--json]                           执行器闸门
  pisa repos [--json]

全局选项：
  --config <path>   配置文件；默认 PISA_CONFIG，否则从当前目录向上找 pisa.config.json
  --url <base>      覆盖管理 API 地址；默认 http://127.0.0.1:<web.port>

鉴权：
  token 取自配置的 web.tokenEnv（默认 PISA_WEB_TOKEN），随 Authorization: Bearer 发送

退出码：
  0 正常        1 需重启（merge 已落盘，重启后生效）
  2 部件错误    3 待配置（配置文件、token、仓库白名单）
`;
}

async function dispatch(io: Io, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positional[0] ?? (args.flags.get("help") ? "help" : undefined);
  if (!command || command === "help" || args.flags.get("help")) {
    io.out(helpText());
    return EXIT.ok;
  }

  if (command === "repos") {
    const cfg = openConfig(args);
    const rows = cfg.repos.map((r) => ({
      alias: r.alias,
      path: r.path,
      remote: r.remote ?? null,
      baseBranch: r.baseBranch ?? null,
      allowed: cfg.whitelist.repos.length === 0 || cfg.whitelist.repos.includes(r.alias),
    }));
    if (args.flags.get("json")) printJson(io, rows);
    else if (rows.length === 0) io.out("(配置里没有仓库)");
    else for (const r of rows) io.out(`${r.alias} · ${r.allowed ? "可用" : "未授权"} · ${r.path}`);
    return EXIT.ok;
  }

  const cfg = openConfig(args);
  const client = resolveClient(args, cfg);

  switch (command) {
    case "run":
    case "task": {
      const brief = args.positional.slice(1).join(" ").trim();
      if (!brief) throw new ComponentError("用法：pisa run <需求> [--repo 别名] [--wait] [--json]");
      const body = await call<SubmitResponse>(client, "POST", "/tickets", {
        prompt: brief,
        repo: flagString(args, "repo") ?? process.env.PISA_REPO,
        eventId: flagString(args, "event-id"),
      });
      if (args.flags.get("json")) {
        printJson(io, args.flags.get("wait") ? body.ticket : { ...body.ticket, message: body.message });
      } else {
        io.out(`${body.ticket.id} · ${body.ticket.status} · ${body.ticket.repo}`);
        io.out(body.message);
      }
      return args.flags.get("wait") ? await waitForTicket(io, client, args, body.ticketId) : EXIT.ok;
    }

    case "continue": {
      const parentId = needPositional(args, 1, "pisa continue <任务号> <新要求>");
      const brief = args.positional.slice(2).join(" ").trim();
      if (!brief) throw new ComponentError("用法：pisa continue <任务号> <新要求>");
      const body = await call<SubmitResponse>(
        client,
        "POST",
        `/tickets/${encodeURIComponent(parentId)}/continue`,
        { prompt: brief, eventId: flagString(args, "event-id") },
      );
      printJson(io, body);
      return args.flags.get("wait") ? await waitForTicket(io, client, args, body.ticketId) : EXIT.ok;
    }

    case "retry": {
      const id = needPositional(args, 1, "pisa retry <任务号>");
      const body = await call<RetryResponse>(client, "POST", `/tickets/${encodeURIComponent(id)}/retry`);
      if (args.flags.get("json")) printJson(io, body);
      else {
        io.out(`${body.ticket.id} · ${body.ticket.status} · ${body.ticket.repo}`);
        io.out(`已重试自 ${body.retriedFrom}`);
      }
      return args.flags.get("wait") ? await waitForTicket(io, client, args, body.ticketId) : EXIT.ok;
    }

    case "stop":
    case "cancel": {
      const id = needPositional(args, 1, "pisa stop <任务号>");
      const body = await call<ActionResponse>(client, "POST", `/tickets/${encodeURIComponent(id)}/stop`);
      if (args.flags.get("json")) printJson(io, body);
      else io.out(`已停止：${id}（${body.status ?? "未知"}）`);
      return EXIT.ok;
    }

    case "merge": {
      const id = needPositional(args, 1, "pisa merge <任务号> [--force]");
      const body = await call<MergeResponse>(client, "POST", `/tickets/${encodeURIComponent(id)}/merge`, {
        confirm: true,
        force: args.flags.get("force") === true,
      });
      if (args.flags.get("json")) printJson(io, body);
      else io.out(body.message);
      return body.restartRequired ? EXIT.restart : EXIT.ok;
    }

    case "rewind": {
      const id = needPositional(args, 1, "pisa rewind <任务号> [--yes]");
      const body = await call<RewindResponse>(client, "POST", `/tickets/${encodeURIComponent(id)}/rewind`, {
        confirm: args.flags.get("yes") === true,
      });
      if (args.flags.get("json")) printJson(io, body);
      else io.out(body.message);
      return EXIT.ok;
    }

    case "wait": {
      const id = needPositional(args, 1, "pisa wait <任务号>");
      return await waitForTicket(io, client, args, id);
    }

    case "status": {
      const repo = flagString(args, "repo");
      const body = await call<StateResponse>(client, "GET", `/state${queryOf({ repo })}`);
      if (args.flags.get("json")) {
        printJson(io, body);
        return EXIT.ok;
      }
      io.out(formatBoard(body));
      const beat = body.daemon.ageMs === null ? "无心跳记录" : `最后心跳 ${formatDuration(body.daemon.ageMs)} 前`;
      io.out(`守护进程：${body.daemon.alive ? "运行中" : "未运行"}（${beat}）`);
      io.out(
        `执行器：${body.executor.paused ? "已暂停" : "运行中"}（${body.executor.running}/${body.executor.concurrency}）`,
      );
      return EXIT.ok;
    }

    case "list": {
      const status = flagString(args, "status");
      if (status && !STATUSES.includes(status as TaskStatus)) {
        throw new ComponentError(`未知状态：${status}；可选 ${STATUSES.join("/")}`);
      }
      const path = `/tickets${queryOf({
        repo: flagString(args, "repo"),
        status,
        limit: flagNumber(args, "limit") ?? 20,
        pr: flagNumber(args, "pr"),
        "github-repo": flagString(args, "github-repo"),
      })}`;
      const body = await call<ListResponse>(client, "GET", path);
      if (args.flags.get("json")) {
        printJson(io, body.tickets);
        return EXIT.ok;
      }
      if (body.tickets.length === 0) io.out("(无任务)");
      for (const t of body.tickets) {
        const extra = t.prUrl ? ` · ${t.prUrl}` : "";
        io.out(`${t.id} · ${t.status} · ${t.repo} · ${preview(t.prompt, 60)}${extra}`);
      }
      return EXIT.ok;
    }

    case "show": {
      const id = needPositional(args, 1, "pisa show <任务号>");
      const body = await call<TicketResponse>(client, "GET", `/tickets/${encodeURIComponent(id)}`);
      if (args.flags.get("json")) {
        printJson(io, body.ticket);
        return EXIT.ok;
      }
      ticketHuman(io, cfg, body.ticket);
      for (const e of body.effects) io.out(`效果：${e.kind} · ${e.target ?? "-"} · ${e.detail ?? "-"}`);
      return EXIT.ok;
    }

    case "logs": {
      const id = needPositional(args, 1, "pisa logs <任务号> [--tail N]");
      const tail = Math.max(1, flagNumber(args, "tail") ?? 80);
      const body = await call<LogsResponse>(client, "GET", `/tickets/${encodeURIComponent(id)}/logs${queryOf({ tail })}`);
      if (args.flags.get("json")) {
        printJson(io, body);
        return EXIT.ok;
      }
      io.out(body.lines.length > 0 ? body.lines.join("\n") : "(日志为空)");
      return EXIT.ok;
    }

    case "pause":
    case "resume": {
      const body = await call<PauseResponse>(client, "POST", "/executor/pause", { paused: command === "pause" });
      if (args.flags.get("json")) printJson(io, body);
      else io.out(`执行器已${body.executor.paused ? "暂停" : "恢复"}（运行中 ${body.executor.running}）`);
      return EXIT.ok;
    }

    default:
      throw new ComponentError(`未知命令：${command}；pisa help 查看用法`);
  }
}

export async function runCli(argv: string[], io: Partial<Io> = {}): Promise<number> {
  const merged: Io = { ...defaultIo, ...io };
  try {
    return await dispatch(merged, argv);
  } catch (err) {
    if (err instanceof ConfigError) {
      merged.err(err.message);
      return EXIT.config;
    }
    if (err instanceof ComponentError) {
      merged.err(err.message);
      return EXIT.component;
    }
    merged.err(err instanceof Error ? err.message : String(err));
    return EXIT.component;
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
