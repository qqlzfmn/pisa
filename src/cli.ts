#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { DEFAULT_WEB, findConfig, loadConfig, type Config, type WebConfig } from "./config";
import { isTaskStatus, TASK_STATUSES, type TaskStatus } from "./types";
import { preview } from "./status";
import type { ErrorReason } from "./http";

/** 退出码：脚本据此分支，不要在版本间随意改语义 */
const EXIT = {
  ok: 0,
  restart: 1,
  component: 2,
  config: 3,
} as const;

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
};

/** 已判定退出码的失败：dispatch 捕获后直接返回，不再继续执行 */
class CliExit extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOL_FLAGS = new Set(["json", "wait", "help", "force", "yes"]);
const VALUE_FLAGS = new Set(["config", "repo", "event-id", "requester", "timeout", "interval", "status", "limit", "pr", "tail"]);

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
      if (eq !== -1) throw new CliExit(EXIT.config, `--${name} 不接受取值`);
      flags.set(name, true);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new CliExit(EXIT.config, `未知选项 --${name}`);
    const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value.startsWith("--")) throw new CliExit(EXIT.config, `--${name} 缺少取值`);
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
  if (!Number.isFinite(n)) throw new CliExit(EXIT.config, `--${name} 需要数字，收到 ${raw}`);
  return Math.floor(n);
}

function emit(io: Io, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

function resolveConfigPath(args: ParsedArgs): string {
  return flagString(args, "config") ?? process.env.PISA_CONFIG ?? findConfig(process.cwd());
}

const TERMINAL: readonly TaskStatus[] = ["succeeded", "failed", "cancelled", "rewound"];

/** 接口错误归类到退出码：3 待配置，2 部件/状态错误 */
const EXIT_BY_REASON: Record<ErrorReason, number> = {
  auth: EXIT.config,
  config: EXIT.config,
  not_found: EXIT.config,
  state: EXIT.component,
  component: EXIT.component,
};

interface Client {
  base: string;
  tokenEnv: string;
  cfg: Config;
  get: (path: string) => Promise<Record<string, unknown>>;
  post: (path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** CLI 只是管理接口的客户端：配置只用来定位端口与 token，业务数据全部来自 HTTP */
function connect(args: ParsedArgs): Client {
  const path = resolveConfigPath(args);
  if (!existsSync(path)) {
    throw new CliExit(EXIT.config, `找不到配置文件：${path}；可用 --config 指定`);
  }
  const cfg = loadConfig(path);
  const web: WebConfig = cfg.web ?? DEFAULT_WEB;
  const token = process.env[web.tokenEnv]?.trim();
  if (!token) {
    throw new CliExit(EXIT.config, `缺少访问 token：设置环境变量 ${web.tokenEnv}（与守护进程一致）`);
  }
  const base = `http://127.0.0.1:${web.port}`;

  async function call(method: string, pathname: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${base}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new CliExit(EXIT.restart, `控制面不可达：${base}；守护进程没在运行，或 web.port 不是 ${web.port}`);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return data;
    const message = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    const reason = (typeof data.reason === "string" ? data.reason : "component") as ErrorReason;
    const code = res.status === 401 ? EXIT.config : (EXIT_BY_REASON[reason] ?? EXIT.component);
    throw new CliExit(code, res.status === 401 ? `token 不匹配：检查 ${web.tokenEnv}` : message);
  }

  return {
    base,
    tokenEnv: web.tokenEnv,
    cfg,
    get: (pathname) => call("GET", pathname),
    post: (pathname, body) => call("POST", pathname, body),
  };
}

interface WireTask {
  id: string;
  status: TaskStatus;
  statusLabel?: string;
  stageLabel?: string;
  repo: string;
  branch: string | null;
  prUrl: string | null;
  prompt: string;
  summary: string | null;
  error: string | null;
  createdAt: number;
  duration: number | null;
}

function taskLine(task: WireTask): string {
  return `${task.id} · ${task.status} · ${task.repo} · ${preview(task.prompt, 60)}`;
}

function showTask(io: Io, task: WireTask, logTail: string[] = []): void {
  io.out(`任务：${task.id}`);
  io.out(`状态：${task.statusLabel ?? task.status}`);
  io.out(`阶段：${task.stageLabel ?? "-"}`);
  io.out(`仓库：${task.repo}`);
  io.out(`需求：${preview(task.prompt, 120)}`);
  io.out(`分支：${task.branch ?? "(未创建)"}`);
  io.out(`PR：${task.prUrl ?? "(无)"}`);
  io.out(`创建：${new Date(task.createdAt).toISOString()}`);
  io.out(`耗时：${task.duration === null ? "-" : `${Math.round(task.duration / 1000)}s`}`);
  if (task.summary) io.out(`摘要：${task.summary}`);
  if (task.error) io.out(`错误：${task.error}`);
  if (logTail.length > 0) {
    io.out("日志：");
    for (const line of logTail.slice(-10)) io.out(`  ${line}`);
  }
}

async function detail(client: Client, id: string): Promise<Record<string, unknown>> {
  return client.get(`/api/tasks/${encodeURIComponent(id)}`);
}

/** 轮询到终态；返回退出码，不做输出（调用方按需渲染） */
async function poll(io: Io, client: Client, args: ParsedArgs, id: string, quiet: boolean): Promise<Record<string, unknown>> {
  const timeoutSec = flagNumber(args, "timeout") ?? 1800;
  const intervalMs = Math.max(10, flagNumber(args, "interval") ?? 1000);
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const task = (await detail(client, id)).task as WireTask;
    if (TERMINAL.includes(task.status)) return task as unknown as Record<string, unknown>;
    if (task.status === "paused") {
      if (!quiet) io.err(`任务 ${task.id} 已暂停：pisa resume ${task.id} 或重启守护进程`);
      return task as unknown as Record<string, unknown>;
    }
    if (Date.now() >= deadline) {
      if (!quiet) io.err(`等待超时，任务仍在 ${task.status}：${task.id}`);
      return { ...task, timeout: true } as unknown as Record<string, unknown>;
    }
    await Bun.sleep(intervalMs);
  }
}

/** 等待结果的退出码：只有 succeeded 是正常结束 */
function codeOfTask(task: Record<string, unknown>): number {
  if (task.timeout === true) return EXIT.restart;
  const status = task.status as TaskStatus;
  if (status === "succeeded") return EXIT.ok;
  if (status === "paused") return EXIT.restart;
  return EXIT.component;
}

function printWait(io: Io, args: ParsedArgs, task: Record<string, unknown>): void {
  if (args.flags.get("json")) {
    emit(io, task);
    return;
  }
  const t = task as unknown as WireTask;
  io.out(`${t.id} · ${t.status}`);
  if (t.summary) io.out(t.summary);
  if (t.error) io.err(t.error);
  if (t.prUrl) io.out(t.prUrl);
}

function frame(daemon: unknown): string {
  const d = daemon as { alive?: boolean; ageMs?: number | null } | null;
  if (!d) return "守护进程：未知";
  if (d.alive) return "守护进程：运行中";
  const age = typeof d.ageMs === "number" ? `${Math.round(d.ageMs / 1000)}s 前` : "未知";
  return `守护进程：未运行（最后心跳 ${age}）`;
}

export function helpText(): string {
  return `pisa CLI：管理接口的客户端，所有操作都发给本机守护进程

用法：
  pisa run <需求> [--repo 别名] [--wait] [--json]         派活（别名 task）
  pisa continue <任务号> <新要求> [--wait] [--json]
  pisa wait <任务号> [--timeout 秒] [--interval 毫秒] [--json]
  pisa status [--json]                                    队列、执行器与健康
  pisa list [--repo 别名] [--status 状态] [--limit N] [--pr 编号] [--json]
  pisa show <任务号> [--json]
  pisa logs <任务号> [--tail N] [--json]
  pisa cancel <任务号>                                    别名 stop
  pisa resume <任务号>
  pisa retry <任务号>
  pisa merge <任务号> [--force]
  pisa rewind <任务号> [--yes] [--json]
  pisa executor [pause|resume] [--json]
  pisa repos [--json]

全局选项：
  --config <path>   配置文件；默认 PISA_CONFIG，否则从当前目录向上找 pisa.config.json

退出码：
  0 正常    1 需要重启（控制面不可达/心跳过期/执行器暂停/任务暂停/等待超时）
  2 部件错误（任务失败、动作被状态拒绝、合并或撤销失败、接口 5xx）
  3 待配置（缺配置、缺 token 或 token 不符、仓库不可用、任务不存在、用法错误）
`;
}

async function dispatch(io: Io, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positional[0] ?? (args.flags.get("help") ? "help" : undefined);
  if (!command || command === "help" || args.flags.get("help")) {
    io.out(helpText());
    return EXIT.ok;
  }

  const client = connect(args);
  const rest = args.positional.slice(1);
  const brief = rest.join(" ").trim();

  switch (command) {
    case "run":
    case "task": {
      if (!brief) throw new CliExit(EXIT.config, "run 需要需求正文");
      const body: Record<string, unknown> = { prompt: brief };
      const repo = flagString(args, "repo") ?? process.env.PISA_REPO;
      if (repo) body.repo = repo;
      const eventId = flagString(args, "event-id");
      if (eventId) body.eventId = eventId;
      const requester = flagString(args, "requester") ?? process.env.PISA_CLI_USER;
      if (requester) body.requester = requester;
      const result = await client.post("/api/tasks", body);
      const task = (result.task ?? result) as WireTask;
      if (args.flags.get("wait")) {
        if (!args.flags.get("json")) {
          io.out(`${task.id} · ${task.status} · ${task.repo}`);
          if (typeof result.message === "string") io.out(result.message);
        }
        const done = await poll(io, client, args, task.id, false);
        printWait(io, args, done);
        return codeOfTask(done);
      }
      if (args.flags.get("json")) {
        emit(io, { ...task, message: result.message });
        return EXIT.ok;
      }
      io.out(taskLine(task));
      if (typeof result.message === "string") io.out(result.message);
      return EXIT.ok;
    }

    case "continue": {
      const [id, ...tail] = rest;
      if (!id) throw new CliExit(EXIT.config, "continue 需要任务号");
      const prompt = tail.join(" ").trim();
      if (!prompt) throw new CliExit(EXIT.config, "continue 需要新要求");
      const result = await client.post(`/api/tasks/${encodeURIComponent(id)}/continue`, { prompt });
      const task = (result.task ?? result) as WireTask;
      if (args.flags.get("wait")) {
        if (!args.flags.get("json")) io.out(`${task.id} · ${task.status}`);
        const done = await poll(io, client, args, task.id, false);
        printWait(io, args, done);
        return codeOfTask(done);
      }
      if (args.flags.get("json")) {
        emit(io, { ...task, message: result.message });
        return EXIT.ok;
      }
      io.out(taskLine(task));
      if (typeof result.message === "string") io.out(result.message);
      return EXIT.ok;
    }

    case "wait": {
      const id = rest[0];
      if (!id) throw new CliExit(EXIT.config, "wait 需要任务号");
      const done = await poll(io, client, args, id, Boolean(args.flags.get("json")));
      printWait(io, args, done);
      return codeOfTask(done);
    }

    case "status": {
      const state = await client.get("/api/state");
      if (args.flags.get("json")) {
        emit(io, state);
      } else {
        io.out(String(state.text ?? ""));
        io.out(frame(state.daemon));
        const executor = state.executor as { paused?: boolean; running?: number; limit?: number } | undefined;
        if (executor) io.out(`执行器：${executor.paused ? "已暂停" : "运行中"} · 运行 ${executor.running ?? 0}/${executor.limit ?? 0}`);
      }
      return state.ok === true ? EXIT.ok : EXIT.restart;
    }

    case "list": {
      const query = new URLSearchParams();
      for (const key of ["repo", "status", "limit", "pr"] as const) {
        const value = flagString(args, key);
        if (value !== undefined) query.set(key, value);
      }
      const status = flagString(args, "status");
      if (status && !isTaskStatus(status)) {
        throw new CliExit(EXIT.config, `未知状态：${status}（可选 ${TASK_STATUSES.join("/")}）`);
      }
      const data = await client.get(`/api/tasks?${query.toString()}`);
      const tasks = (data.tasks as unknown[] | undefined) ?? [];
      if (args.flags.get("json")) emit(io, tasks);
      else if (tasks.length === 0) io.out("(没有任务)");
      else for (const t of tasks) io.out(taskLine(t as WireTask));
      return EXIT.ok;
    }

    case "show": {
      const id = rest[0];
      if (!id) throw new CliExit(EXIT.config, "show 需要任务号");
      const data = await detail(client, id);
      if (args.flags.get("json")) {
        emit(io, data);
        return EXIT.ok;
      }
      showTask(io, data.task as WireTask, (data.logTail as string[] | undefined) ?? []);
      for (const e of (data.effects as Array<{ kind: string; target: string }> | undefined) ?? []) io.out(`效果：${e.kind} ${e.target}`);
      return EXIT.ok;
    }

    case "logs": {
      const id = rest[0];
      if (!id) throw new CliExit(EXIT.config, "logs 需要任务号");
      const tail = flagString(args, "tail") ?? "80";
      const data = await client.get(`/api/tasks/${encodeURIComponent(id)}/logs?tail=${encodeURIComponent(tail)}`);
      const lines = (data.lines as string[] | undefined) ?? [];
      if (args.flags.get("json")) emit(io, lines);
      else if (lines.length === 0) io.out("(没有日志)");
      else for (const line of lines) io.out(line);
      return EXIT.ok;
    }

    case "cancel":
    case "stop":
    case "resume":
    case "retry":
    case "merge":
    case "rewind": {
      const id = rest[0];
      if (!id) throw new CliExit(EXIT.config, `${command} 需要任务号`);
      const action = command === "stop" ? "cancel" : command;
      const body: Record<string, unknown> = {};
      if (action === "merge") {
        body.confirm = true;
        if (args.flags.get("force")) body.force = true;
      }
      if (action === "rewind" && args.flags.get("yes")) body.yes = true;
      const data = await client.post(`/api/tasks/${encodeURIComponent(id)}/${action}`, body);
      if (args.flags.get("json")) {
        emit(io, data);
        return EXIT.ok;
      }
      const message = typeof data.message === "string" ? data.message : "";
      const taskId = typeof data.taskId === "string" ? data.taskId : id;
      if (action === "retry") io.out(`${taskId} · 已接单`);
      else io.out(`${id} · ${String(data.status ?? "")}`.trim());
      if (message) io.out(message);
      return EXIT.ok;
    }

    case "executor": {
      const arg = rest[0];
      if (!arg) {
        const state = await client.get("/api/state");
        const executor = state.executor as { paused?: boolean; running?: number; limit?: number };
        if (args.flags.get("json")) emit(io, executor);
        else io.out(`执行器：${executor.paused ? "已暂停" : "运行中"} · 运行 ${executor.running ?? 0}/${executor.limit ?? 0}`);
        return EXIT.ok;
      }
      if (arg !== "pause" && arg !== "resume") throw new CliExit(EXIT.config, "executor 只接受 pause 或 resume");
      const data = await client.post("/api/executor/pause", { paused: arg === "pause" });
      const executor = data.executor as { paused?: boolean };
      if (args.flags.get("json")) emit(io, data);
      else io.out(`执行器：${executor.paused ? "已暂停（不再领取排队任务）" : "已恢复"}`);
      return EXIT.ok;
    }

    case "repos": {
      const state = await client.get("/api/state");
      const repos = (state.repos as unknown[] | undefined) ?? [];
      if (args.flags.get("json")) emit(io, repos);
      else if (repos.length === 0) io.out("(配置里没有仓库)");
      else {
        for (const r of repos as Array<{ alias: string; allowed: boolean; path: string }>) {
          io.out(`${r.alias} · ${r.allowed ? "可用" : "未授权"} · ${r.path}`);
        }
      }
      return EXIT.ok;
    }

    default:
      throw new CliExit(EXIT.config, `未知命令 ${command}；pisa help 查看用法`);
  }
}

/** 进程内可测入口：返回退出码，输出走传入的 io */
export async function runCli(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    return await dispatch(io, argv);
  } catch (err) {
    if (err instanceof CliExit) {
      io.err(err.message);
      return err.code;
    }
    io.err(err instanceof Error ? err.message : String(err));
    return EXIT.component;
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
