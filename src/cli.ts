#!/usr/bin/env bun
// pisa CLI：管理接口的客户端。所有查询与操作都发 HTTP 请求，不打开数据库。
// 退出码是契约：0 正常 / 1 需重启 / 2 部件错误 / 3 待配置。

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type Config } from "./config";
import { readManagementToken } from "./mgmt";
import type { WindowMetrics } from "./metrics";
import {
  formatBoard,
  formatWindowMetrics,
  type BoardView,
  type DaemonState,
  type TaskJson,
} from "./status";
import type { TaskStatus } from "./types";

export const EXIT = {
  ok: 0,
  restart: 1,
  fault: 2,
  unconfigured: 3,
} as const;

const TERMINAL: Partial<Record<TaskStatus, true>> = {
  succeeded: true,
  failed: true,
  cancelled: true,
  rewound: true,
};
const BOOL_FLAGS: Record<string, true> = { json: true, wait: true, help: true, confirm: true, yes: true, force: true, resume: true };
const VALUE_FLAGS: Record<string, true> = {
  config: true,
  repo: true,
  "event-id": true,
  timeout: true,
  interval: true,
  status: true,
  limit: true,
  pr: true,
  "github-repo": true,
  tail: true,
};

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

type Flags = Record<string, string | boolean>;

/** 带退出码的错误：顶层统一打印，不再各自 exit */
class CliError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function parseArgs(argv: string[]): { flags: Flags; args: string[] } {
  const flags: Flags = {};
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      args.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    if (name in BOOL_FLAGS) {
      flags[name] = eq > 0 ? arg.slice(eq + 1) !== "false" : true;
      continue;
    }
    if (!(name in VALUE_FLAGS)) throw new CliError(EXIT.fault, `未知参数：--${name}`);
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new CliError(EXIT.fault, `参数 --${name} 缺少值`);
    flags[name] = value;
  }
  return { flags, args };
}

function str(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function num(flags: Flags, name: string, fallback: number): number {
  const raw = str(flags, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(EXIT.fault, `参数 --${name} 需要正数`);
  return n;
}

interface Client {
  cfg: Config;
  base: string;
  token: string;
}

interface ExecutorView {
  paused: boolean;
  active: number;
  concurrency: number;
}

interface StateResponse extends BoardView {
  daemon: DaemonState;
  executor: ExecutorView;
  last24h: WindowMetrics;
}

interface TicketDetail {
  task: TaskJson;
  effects: Array<{ kind: string; target: string | null }>;
  logTail: string[];
}

interface TicketList {
  tickets: TaskJson[];
}

interface SubmitResponse {
  taskId: string;
  task: TaskJson;
  message: string;
}

interface ActionResponse {
  status: TaskStatus | null;
  message: string;
  taskId?: string | null;
  restart?: "auto" | "manual";
}

/** 连接信息来自配置与 token：读不到就属于「待配置」，不是运行故障 */
function connect(flags: Flags): Client {
  const path = str(flags, "config") ?? process.env.PISA_CONFIG ?? "pisa.config.json";
  // loadConfig 缺文件时静默回落到默认值：CLI 不能把「没有配置」当成「配置好了但没开接口」
  if (!existsSync(resolve(path))) {
    throw new CliError(EXIT.unconfigured, `读不到配置：${resolve(path)}（用 --config 指定）`);
  }
  let cfg: Config;
  try {
    cfg = loadConfig(path);
  } catch (err) {
    throw new CliError(EXIT.unconfigured, `配置无法解析：${err instanceof Error ? err.message : String(err)}`);
  }
  if (cfg.web?.enabled !== true) {
    throw new CliError(EXIT.unconfigured, "管理接口未启用：在配置里设 web.enabled = true 后重启守护进程");
  }
  const token = process.env[cfg.web.tokenEnv]?.trim() || readManagementToken(cfg.stateDir);
  if (!token) throw new CliError(EXIT.unconfigured, `找不到管理 token：设 ${cfg.web.tokenEnv} 或确认守护进程已启动`);
  return { cfg, base: `http://127.0.0.1:${cfg.web.port}`, token };
}

/** 响应体由本机守护进程产出：此处按调用方声明的形状取用，运行时只校验错误字段 */
async function call<T>(c: Client, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${c.base}${path}`, {
      method,
      headers: { "x-pisa-token": c.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CliError(EXIT.fault, `连不上管理接口 ${c.base}：守护进程在跑吗？`);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return data as T;
  const error = apiError(data);
  const message = error.error ?? `HTTP ${res.status}`;
  if (error.code === "config" || error.code === "auth") throw new CliError(EXIT.unconfigured, message);
  throw new CliError(EXIT.fault, message);
}

function apiError(data: unknown): { code?: string; error?: string } {
  if (!data || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

function exitForTask(task: TaskJson): number {
  return task.status === "succeeded" ? EXIT.ok : EXIT.fault;
}

function printTask(io: Io, task: TaskJson): void {
  io.out(`${task.id} · ${task.status}${task.stage ? ` · ${task.stage}` : ""} · ${task.repo}`);
  if (task.prompt) io.out(`需求：${task.prompt}`);
  if (task.branch) io.out(`分支：${task.branch}`);
  if (task.prUrl) io.out(`PR：${task.prUrl}`);
  if (task.summary) io.out(`结果：${task.summary}`);
  if (task.error) io.out(`错误：${task.error}`);
}

/** 轮询到终态；超时也是部件错误，不假装成功 */
async function waitFor(c: Client, id: string, flags: Flags, io: Io): Promise<TaskJson> {
  const interval = num(flags, "interval", 2) * 1000;
  const timeoutMs = num(flags, "timeout", 900) * 1000;
  const deadline = Date.now() + timeoutMs;
  const quiet = flags.json === true;
  for (;;) {
    const data = await call<TicketDetail>(c, "GET", `/tickets/${encodeURIComponent(id)}?logTail=1`);
    const task = data.task;
    if (TERMINAL[task.status]) return task;
    if (Date.now() >= deadline) {
      throw new CliError(EXIT.fault, `等待超时（${timeoutMs / 1000}s）：${id} 仍是 ${task.status}`);
    }
    if (!quiet) io.out(`${task.id} ${task.status}${task.stageLabel ? ` · ${task.stageLabel}` : ""}`);
    await Bun.sleep(interval);
  }
}

async function statusCommand(c: Client, flags: Flags, io: Io): Promise<number> {
  const data = await call<StateResponse>(c, "GET", "/state");
  if (flags.json) {
    io.out(JSON.stringify(data, null, 2));
    return EXIT.ok;
  }
  const executor = data.executor;
  io.out(formatBoard(data));
  io.out(formatWindowMetrics(data.last24h));
  io.out(`执行器：${executor.paused ? "已暂停" : "运行中"} · 运行 ${executor.active}/${executor.concurrency}`);
  return EXIT.ok;
}

async function listCommand(c: Client, flags: Flags, io: Io): Promise<number> {
  const query = new URLSearchParams();
  for (const key of ["repo", "status", "limit", "pr", "github-repo"] as const) {
    const value = str(flags, key);
    if (value !== undefined) query.set(key, value);
  }
  const data = await call<TicketList>(c, "GET", `/tickets?${query.toString()}`);
  if (flags.json) {
    io.out(JSON.stringify(data, null, 2));
    return EXIT.ok;
  }
  const tickets = data.tickets;
  if (tickets.length === 0) io.out("没有匹配的任务。");
  for (const t of tickets) io.out(`${t.id}  ${t.status.padEnd(9)} ${t.repo.padEnd(12)} ${t.prompt}`);
  return EXIT.ok;
}

async function showCommand(c: Client, flags: Flags, args: string[], io: Io): Promise<number> {
  const id = args[0];
  if (!id) throw new CliError(EXIT.fault, "用法：pisa show <任务号>");
  const data = await call<TicketDetail>(c, "GET", `/tickets/${encodeURIComponent(id)}?logTail=${num(flags, "tail", 200)}`);
  if (flags.json) {
    io.out(JSON.stringify(data, null, 2));
    return EXIT.ok;
  }
  printTask(io, data.task);
  for (const e of data.effects) io.out(`副作用：${e.kind}${e.target ? ` ${e.target}` : ""}`);
  for (const line of data.logTail) io.out(line);
  return EXIT.ok;
}

/** run 与 continue 共用：提交后用 --wait 等到终态 */
async function submit(c: Client, flags: Flags, io: Io, payload: Record<string, unknown>): Promise<number> {
  const data = await call<SubmitResponse>(c, "POST", "/tickets", payload);
  const task = data.task;
  if (flags.wait !== true) {
    if (flags.json) io.out(JSON.stringify(data, null, 2));
    else io.out(`${data.message}\n任务号：${task.id}`);
    return EXIT.ok;
  }
  const done = await waitFor(c, task.id, flags, io);
  if (flags.json) io.out(JSON.stringify(done, null, 2));
  else printTask(io, done);
  return exitForTask(done);
}

async function runCommand(c: Client, flags: Flags, args: string[], io: Io): Promise<number> {
  const prompt = args.join(" ").trim();
  if (!prompt) throw new CliError(EXIT.fault, "用法：pisa run <需求> [--repo 别名] [--wait] [--json]");
  const payload: Record<string, unknown> = { prompt };
  const repo = str(flags, "repo");
  if (repo) payload.repo = repo;
  const eventId = str(flags, "event-id");
  if (eventId) payload.eventId = eventId;
  return submit(c, flags, io, payload);
}

async function continueCommand(c: Client, flags: Flags, args: string[], io: Io): Promise<number> {
  const [parent, ...rest] = args;
  const prompt = rest.join(" ").trim();
  if (!parent || !prompt) throw new CliError(EXIT.fault, "用法：pisa continue <任务号> <需求>");
  const payload: Record<string, unknown> = { prompt, continueFrom: parent };
  const repo = str(flags, "repo");
  if (repo) payload.repo = repo;
  return submit(c, flags, io, payload);
}

async function waitCommand(c: Client, flags: Flags, args: string[], io: Io): Promise<number> {
  const id = args[0];
  if (!id) throw new CliError(EXIT.fault, "用法：pisa wait <任务号> [--timeout 秒]");
  const done = await waitFor(c, id, flags, io);
  if (flags.json) io.out(JSON.stringify(done, null, 2));
  else printTask(io, done);
  return exitForTask(done);
}

async function logsCommand(c: Client, flags: Flags, args: string[], io: Io): Promise<number> {
  const id = args[0];
  if (!id) throw new CliError(EXIT.fault, "用法：pisa logs <任务号> [--tail 行数]");
  const data = await call<TicketDetail>(c, "GET", `/tickets/${encodeURIComponent(id)}?logTail=${num(flags, "tail", 200)}`);
  if (flags.json) io.out(JSON.stringify({ ok: true, taskId: id, logTail: data.logTail }, null, 2));
  else for (const line of data.logTail) io.out(line);
  return EXIT.ok;
}

async function retryCommand(c: Client, flags: Flags, args: string[], io: Io): Promise<number> {
  const id = args[0];
  if (!id) throw new CliError(EXIT.fault, "用法：pisa retry <任务号> [--wait]");
  const data = await call<SubmitResponse>(c, "POST", `/tickets/${encodeURIComponent(id)}/retry`);
  if (flags.wait !== true) {
    if (flags.json) io.out(JSON.stringify(data, null, 2));
    else io.out(`${data.message}\n任务号：${data.taskId}`);
    return EXIT.ok;
  }
  const done = await waitFor(c, data.taskId, flags, io);
  if (flags.json) io.out(JSON.stringify(done, null, 2));
  else printTask(io, done);
  return exitForTask(done);
}

async function stopCommand(c: Client, flags: Flags, args: string[], io: Io): Promise<number> {
  const id = args[0];
  if (!id) throw new CliError(EXIT.fault, "用法：pisa stop <任务号>");
  const data = await call<ActionResponse>(c, "POST", `/tickets/${encodeURIComponent(id)}/stop`);
  if (flags.json) io.out(JSON.stringify(data, null, 2));
  else io.out(data.message || `已请求停止 ${id}`);
  return EXIT.ok;
}

async function pauseCommand(c: Client, flags: Flags, io: Io): Promise<number> {
  const paused = flags.resume !== true;
  const data = await call<{ executor: ExecutorView }>(c, "POST", "/executor/pause", { paused });
  if (flags.json) io.out(JSON.stringify(data, null, 2));
  else io.out(paused ? "已暂停派活：排队任务不再出队，运行中的任务继续。" : "已恢复派活。");
  return EXIT.ok;
}

async function mergeCommand(c: Client, flags: Flags, args: string[], io: Io): Promise<number> {
  const id = args[0];
  if (!id) throw new CliError(EXIT.fault, "用法：pisa merge <任务号> --confirm [--force]");
  if (flags.confirm !== true) throw new CliError(EXIT.fault, "合并前要显式确认：加 --confirm");
  const data = await call<ActionResponse>(c, "POST", `/tickets/${encodeURIComponent(id)}/merge`, {
    confirm: true,
    force: flags.force === true,
  });
  if (flags.json) io.out(JSON.stringify(data, null, 2));
  else io.out(data.message || `已合并 ${id}`);
  // manual：改动要重启守护进程才生效，脚本据此决定是否重启
  return data.restart === "manual" ? EXIT.restart : EXIT.ok;
}

async function rewindCommand(c: Client, flags: Flags, args: string[], io: Io): Promise<number> {
  const id = args[0];
  if (!id) throw new CliError(EXIT.fault, "用法：pisa rewind <任务号> [--yes]");
  const apply = flags.yes === true;
  const data = await call<ActionResponse>(c, "POST", `/tickets/${encodeURIComponent(id)}/rewind`, { confirm: apply });
  if (flags.json) io.out(JSON.stringify(data, null, 2));
  else if (apply) io.out(data.message || `已撤销 ${id}`);
  else io.out(`${data.message}\n（仅预览；加 --yes 执行）`);
  return EXIT.ok;
}

const HELP = `pisa —— 任务守护进程的管理客户端

用法：
  pisa status [--json]                      状态快照
  pisa run <需求> [--repo 别名] [--wait]    派活
  pisa continue <任务号> <需求>              接着上一轮改
  pisa wait <任务号> [--timeout 秒]          等到终态
  pisa show <任务号> [--tail 行数]           任务详情与日志
  pisa logs <任务号> [--tail 行数]           只看日志
  pisa list [--status S] [--repo 别名] [--limit N] [--pr N]
  pisa retry <任务号> [--wait]               同需求重跑
  pisa stop <任务号>                         停止任务
  pisa pause [--resume]                      暂停 / 恢复派活
  pisa merge <任务号> --confirm [--force]    合并分支
  pisa rewind <任务号> [--yes]               撤销已合并的分支

通用参数：--json 机器可读输出 · --config 配置文件
退出码：0 正常 / 1 需重启 / 2 部件错误 / 3 待配置`;

const COMMANDS: Record<string, (c: Client, flags: Flags, args: string[], io: Io) => Promise<number>> = {
  status: (c, flags, _args, io) => statusCommand(c, flags, io),
  list: (c, flags, _args, io) => listCommand(c, flags, io),
  show: showCommand,
  run: runCommand,
  continue: continueCommand,
  wait: waitCommand,
  logs: logsCommand,
  retry: retryCommand,
  stop: stopCommand,
  pause: (c, flags, _args, io) => pauseCommand(c, flags, io),
  merge: mergeCommand,
  rewind: rewindCommand,
};

export async function runCli(argv: string[], io: Io = { out: console.log, err: console.error }): Promise<number> {
  try {
    const { flags, args } = parseArgs(argv);
    const name = args.shift() ?? "";
    if (flags.help === true || name === "help" || !name) {
      io.out(HELP);
      return EXIT.ok;
    }
    const command = COMMANDS[name];
    if (!command) throw new CliError(EXIT.fault, `未知命令：${name}（pisa help 看命令清单）`);
    return await command(connect(flags), flags, args, io);
  } catch (err) {
    if (err instanceof CliError) {
      io.err(`错误：${err.message}`);
      return err.code;
    }
    io.err(`错误：${err instanceof Error ? err.message : String(err)}`);
    return EXIT.fault;
  }
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)));
