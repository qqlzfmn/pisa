#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, repoByAlias, resolveConfigPath, type Config } from "./config";
import { Store } from "./store";
import { isGitRepo } from "./git";
import type { Task, TaskStatus } from "./types";
import { newTaskId } from "./ids";
import { makeTrigger } from "./trigger";
import { continuationContext } from "./task-context";
import { formatDuration, preview, taskJson, type TaskJson } from "./status";
import { stageText } from "./stage";
import { ApiError, mgmtFor, Mgmt, UnauthorizedError, UnconfiguredError, UnreachableError } from "./mgmt";

/**
 * 退出码只有四档，脚本据此分支：
 * 0 正常；1 已保存但需重启；2 部件错误（用法、API、任务失败/超时）；3 待配置。
 */
const EXIT = {
  ok: 0,
  restart: 1,
  component: 2,
  unconfigured: 3,
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

class UsageError extends Error {}

interface ParsedArgs {
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
  "set",
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

function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} 需要数字，收到 ${raw}`);
  return Math.floor(n);
}

function json(io: Io, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

function loadCfg(args: ParsedArgs): Config {
  const configPath = resolveConfigPath(flagString(args, "config"));
  if (!existsSync(configPath)) {
    throw new UnconfiguredError(`找不到配置文件：${configPath}；可用 --config 指定`);
  }
  return loadConfig(configPath);
}

function repoForTask(cfg: Config, alias: string | undefined) {
  const repo = repoByAlias(cfg, alias);
  if (!repo) throw new UsageError(alias ? `未知仓库别名：${alias}` : "配置里没有仓库，请先设置 repos");
  if (cfg.whitelist.repos.length > 0 && !cfg.whitelist.repos.includes(repo.alias)) {
    throw new UsageError(`无权限：仓库 ${repo.alias} 不在 whitelist.repos`);
  }
  if (!isGitRepo(repo.path)) throw new UsageError(`仓库路径不是 git 仓库：${repo.path}`);
  return repo;
}

function cliRequester(args: ParsedArgs): string {
  return flagString(args, "requester") ?? process.env.PISA_CLI_USER ?? process.env.USER ?? "local";
}

function newCliTask(init: Pick<Task, "id" | "requester" | "repo" | "prompt" | "baseRef" | "context" | "prUrl">): Task {
  return {
    ...init,
    source: "cli",
    channel: "cli",
    chatId: "cli",
    status: "queued",
    branch: null,
    sessionId: null,
    replyPr: null,
    replyIssue: null,
    replyRepo: null,
    summary: null,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
  };
}

/** 建单留在本地：即使守护进程没跑，任务也必须落库排队（agent 契约） */
function enqueue(io: Io, cfg: Config, args: ParsedArgs, task: Task): void {
  const store = new Store(join(cfg.stateDir, "pisa.db"));
  try {
    const eventId = flagString(args, "event-id") ?? `cli:${randomUUID()}`;
    const trigger = makeTrigger({
      source: "cli",
      // 每条 CLI 提交自成一册线程；--event-id 相同即视为同一件事
      threadKey: `cli:${eventId}`,
      messageKey: eventId,
      actor: task.requester,
      at: task.createdAt,
      text: task.prompt,
    });
    const claim = store.createTaskFromTrigger(trigger, task);
    if (!claim.created) {
      const existing = store.get(claim.taskId);
      if (existing) {
        const note = claim.promptUpdated
          ? "事件已存在，需求已按最新版本更新"
          : claim.edited
            ? "事件已存在，任务已开跑，本次内容只做了留痕"
            : "事件已存在，返回原任务";
        emitTask(io, args, existing, note);
      }
      return;
    }
    // --wait --json 只输出最终任务，避免两个 JSON 拼在一起无法解析
    if (!(args.flags.get("wait") && args.flags.get("json"))) emitTask(io, args, task, "已入队");
  } finally {
    store.close();
  }
}

function emitTask(io: Io, args: ParsedArgs, task: Task, message: string): void {
  const row = { ...taskJson(task), message };
  if (args.flags.get("json")) json(io, row);
  else {
    io.out(`${task.id} · ${task.status} · ${task.repo}`);
    io.out(message);
  }
}

/** 建单后顺带探一次管理 API，只用来提示守护进程是否在消费队列 */
async function daemonNote(cfg: Config): Promise<string | null> {
  try {
    const state = await mgmtFor(cfg).get<StatePayload>("/api/state");
    return state.daemon.alive ? null : "警告：守护进程心跳已过期，任务会一直排队。";
  } catch (err) {
    if (err instanceof UnconfiguredError) return "提示：未开启管理 API，无法确认守护进程是否在消费队列。";
    return `警告：${err instanceof Error ? err.message : String(err)}`;
  }
}

interface DaemonState {
  alive: boolean;
  ageMs: number | null;
}

interface StatePayload {
  daemon: DaemonState;
  counts: Record<string, number>;
  total: number;
  worker: { concurrency: number; running: number; paused: boolean };
  repos: string[];
  text: string;
}

interface BoardTask extends TaskJson {
  statusLabel: string;
}

interface EffectRow {
  kind: string;
  target: string | null;
  detail: string | null;
  createdAt: number;
}

interface DetailPayload {
  task: BoardTask;
  effects: EffectRow[];
  logTail: string[];
}

interface ListPayload {
  tasks: BoardTask[];
}

interface MessagePayload {
  ok: boolean;
  message?: string;
  status?: string | null;
}

async function apiTask(mgmt: Mgmt, id: string, tail?: number): Promise<DetailPayload> {
  const query = tail === undefined ? "" : `?tail=${tail}`;
  return mgmt.get<DetailPayload>(`/api/tasks/${encodeURIComponent(id)}${query}`);
}

async function waitTask(mgmt: Mgmt, io: Io, args: ParsedArgs, id: string): Promise<number> {
  const timeoutSec = flagNumber(args, "timeout") ?? 1800;
  const intervalMs = Math.max(10, flagNumber(args, "interval") ?? 1000);
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const { task } = await apiTask(mgmt, id);
    if (TERMINAL.includes(task.status)) {
      if (args.flags.get("json")) json(io, task);
      else {
        io.out(`${task.id} · ${task.status}`);
        if (task.summary) io.out(task.summary);
        if (task.error) io.err(task.error);
        if (task.prUrl) io.out(task.prUrl);
      }
      return task.status === "succeeded" ? EXIT.ok : EXIT.component;
    }
    if (task.status === "paused") {
      if (args.flags.get("json")) json(io, task);
      else io.err(`任务 ${task.id} 已暂停，恢复请用 pisa retry ${task.id}`);
      return EXIT.component;
    }
    if (Date.now() >= deadline) {
      if (args.flags.get("json")) json(io, { id: task.id, status: task.status, timeout: true });
      else io.err(`等待超时，任务仍在 ${task.status}：${task.id}`);
      return EXIT.component;
    }
    await Bun.sleep(intervalMs);
  }
}

function taskHuman(io: Io, task: BoardTask, logPath: string): void {
  const rows: Array<[string, string]> = [
    ["任务", task.id],
    ["状态", task.status],
    ["阶段", stageText(task)],
    ["仓库", task.repo],
    ["需求", preview(task.prompt, 120)],
    ["分支", task.branch ?? "(未创建)"],
    ["PR", task.prUrl ?? "(无)"],
    ["创建", new Date(task.createdAt).toISOString()],
    ["耗时", task.duration],
    ["日志", logPath],
  ];
  if (task.summary) rows.push(["摘要", task.summary]);
  if (task.error) rows.push(["错误", task.error]);
  for (const [k, v] of rows) io.out(`${k}：${v}`);
}

/** 写操作统一入口：服务端说不算成功就按部件错误退出 */
async function act(io: Io, args: ParsedArgs, call: Promise<MessagePayload>): Promise<number> {
  const result = await call;
  if (args.flags.get("json")) json(io, result);
  else io.out(result.message ?? (result.ok ? "完成" : "失败"));
  return result.ok ? EXIT.ok : EXIT.component;
}

export function helpText(): string {
  return `pisa CLI：向本地 pisa 守护进程提交任务并查询结果

管理接口（127.0.0.1 的 web 端口，需要 web.enabled 与 token 环境变量）：
  pisa status [--json]                       看板、队列与执行器状态
  pisa list [--repo 别名] [--status 状态] [--limit N] [--pr 编号] [--json]
  pisa show <任务号> [--json]                 任务详情
  pisa logs <任务号> [--tail N] [--json]      任务日志尾部
  pisa wait <任务号> [--timeout 秒] [--interval 毫秒] [--json]
  pisa cancel <任务号>                        停止任务
  pisa retry <任务号> [--wait] [--json]       用原需求重跑（新建任务）
  pisa merge <任务号> --yes                   合并（不可回滚）
  pisa rewind <任务号> [--yes]                撤销预览；加 --yes 执行
  pisa executor pause|resume                  暂停/恢复领取新任务
  pisa config [--json]                        查看可编辑配置
  pisa config --set <json 文件> --yes         保存配置
  pisa repos [--json]                         仓库列表

本地提交（守护进程不在时也入队）：
  pisa run <需求> [--repo 别名] [--wait] [--json]
  pisa continue <任务号> <新要求> [--wait] [--json]

全局选项：
  --config <path>   配置文件；默认 PISA_CONFIG，否则从当前目录向上找 pisa.config.json

退出码：
  0 正常
  1 已保存，需要重启 pisa 生效
  2 部件错误（用法错误、API 不可达、token 不匹配、任务失败或超时）
  3 待配置（找不到配置、web 未启用、缺少 token）
`;
}

async function dispatch(io: Io, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positional[0] ?? (args.flags.get("help") ? "help" : undefined);
  if (!command || command === "help" || args.flags.get("help")) {
    io.out(helpText());
    return EXIT.ok;
  }

  const cfg = loadCfg(args);
  const target = args.positional[1];

  switch (command) {
    case "run":
    case "task": {
      const brief = args.positional.slice(1).join(" ").trim();
      if (!brief) throw new UsageError("run 需要需求正文");
      const repo = repoForTask(cfg, flagString(args, "repo") ?? process.env.PISA_REPO);
      const task = newCliTask({
        id: newTaskId(),
        requester: cliRequester(args),
        repo: repo.alias,
        prompt: brief,
        baseRef: null,
        context: null,
        prUrl: null,
      });
      enqueue(io, cfg, args, task);
      const note = await daemonNote(cfg);
      if (note) io.err(note);
      return args.flags.get("wait") ? await waitTask(mgmtFor(cfg), io, args, task.id) : EXIT.ok;
    }

    case "continue": {
      const brief = args.positional.slice(2).join(" ").trim();
      if (!target || !brief) throw new UsageError("用法：pisa continue <任务号> <新要求>");
      const parent = await apiTask(mgmtFor(cfg), target);
      if (!parent.task.branch) throw new UsageError(`任务 ${target} 没有可续跑的分支`);
      const task = newCliTask({
        id: newTaskId(),
        requester: cliRequester(args),
        repo: parent.task.repo,
        prompt: brief,
        baseRef: parent.task.branch,
        context: continuationContext(parent.task),
        prUrl: parent.task.prUrl,
      });
      enqueue(io, cfg, args, task);
      return args.flags.get("wait") ? await waitTask(mgmtFor(cfg), io, args, task.id) : EXIT.ok;
    }

    case "wait": {
      if (!target) throw new UsageError("用法：pisa wait <任务号>");
      return await waitTask(mgmtFor(cfg), io, args, target);
    }

    case "status": {
      const state = await mgmtFor(cfg).get<StatePayload>("/api/state");
      if (args.flags.get("json")) {
        json(io, state);
        return EXIT.ok;
      }
      io.out(state.text);
      const beat = state.daemon.ageMs === null ? "无心跳记录" : `最后心跳 ${formatDuration(state.daemon.ageMs)} 前`;
      io.out(`守护进程：${state.daemon.alive ? "运行中" : "未运行"}（${beat}）`);
      io.out(
        `执行器：${state.worker.paused ? "已暂停" : "运行中"} · 并发 ${state.worker.concurrency} · 运行中 ${state.worker.running}`,
      );
      return EXIT.ok;
    }

    case "list": {
      const status = flagString(args, "status");
      if (status && !STATUSES.includes(status as TaskStatus)) {
        throw new UsageError(`未知状态：${status}；可选 ${STATUSES.join("/")}`);
      }
      const query = new URLSearchParams();
      const repo = flagString(args, "repo");
      if (repo) query.set("repo", repo);
      if (status) query.set("status", status);
      const limit = flagNumber(args, "limit");
      if (limit !== undefined) query.set("limit", String(limit));
      const pr = flagNumber(args, "pr");
      if (pr !== undefined) {
        query.set("pr", String(pr));
        const githubRepo = flagString(args, "github-repo");
        if (githubRepo) query.set("githubRepo", githubRepo);
      }
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      const payload = await mgmtFor(cfg).get<ListPayload>(`/api/tasks${suffix}`);
      const tasks = payload.tasks;
      if (args.flags.get("json")) {
        json(io, tasks);
        return EXIT.ok;
      }
      if (tasks.length === 0) io.out("(无任务)");
      for (const t of tasks) {
        const extra = t.prUrl ? ` · ${t.prUrl}` : "";
        io.out(`${t.id} · ${t.status} · ${t.repo} · ${preview(t.prompt, 60)}${extra}`);
      }
      return EXIT.ok;
    }

    case "show": {
      if (!target) throw new UsageError("用法：pisa show <任务号>");
      const detail = await apiTask(mgmtFor(cfg), target);
      if (args.flags.get("json")) json(io, detail.task);
      else taskHuman(io, detail.task, join(cfg.stateDir, "logs", `${detail.task.id}.log`));
      return EXIT.ok;
    }

    case "logs": {
      if (!target) throw new UsageError("用法：pisa logs <任务号> [--tail N]");
      const count = Math.max(1, Math.floor(flagNumber(args, "tail") ?? 80));
      const detail = await apiTask(mgmtFor(cfg), target, count);
      const lines = detail.logTail;
      if (args.flags.get("json")) json(io, { id: detail.task.id, tail: count, lines });
      else io.out(lines.length > 0 ? lines.join("\n") : "(日志为空)");
      return EXIT.ok;
    }

    case "cancel": {
      if (!target) throw new UsageError("用法：pisa cancel <任务号>");
      return await act(io, args, mgmtFor(cfg).post(`/api/tasks/${encodeURIComponent(target)}/cancel`, { confirm: true }));
    }

    case "retry": {
      if (!target) throw new UsageError("用法：pisa retry <任务号> [--wait]");
      const mgmt = mgmtFor(cfg);
      const result = await mgmt.post<MessagePayload & { taskId?: string }>(`/api/tasks/${encodeURIComponent(target)}/retry`, {
        confirm: true,
      });
      if (args.flags.get("json") && !args.flags.get("wait")) json(io, result);
      else if (!args.flags.get("json")) io.out(result.message ?? `已重试：${result.taskId ?? target}`);
      if (!result.taskId) return EXIT.component;
      return args.flags.get("wait") ? await waitTask(mgmt, io, args, result.taskId) : EXIT.ok;
    }

    case "merge": {
      if (!target) throw new UsageError("用法：pisa merge <任务号> --yes");
      if (!args.flags.get("yes")) throw new UsageError("合并不可回滚：请确认后加 --yes");
      return await act(io, args, mgmtFor(cfg).post(`/api/tasks/${encodeURIComponent(target)}/merge`, { confirm: true }));
    }

    case "rewind": {
      if (!target) throw new UsageError("用法：pisa rewind <任务号> [--yes]");
      const mgmt = mgmtFor(cfg);
      if (!args.flags.get("yes")) {
        const plan = await mgmt.get<{ ok: boolean; text?: string; actions: unknown[] }>(
          `/api/tasks/${encodeURIComponent(target)}/rewind`,
        );
        if (args.flags.get("json")) json(io, plan);
        else io.out(plan.text ?? "(没有可撤销的动作)");
        return EXIT.ok;
      }
      const result = await mgmt.post<MessagePayload>(
        `/api/tasks/${encodeURIComponent(target)}/rewind`,
        { confirm: true },
      );
      if (args.flags.get("json")) json(io, result);
      else io.out(result.message ?? (result.ok ? "已撤销" : "撤销失败"));
      return result.ok ? EXIT.ok : EXIT.component;
    }

    case "executor": {
      if (target !== "pause" && target !== "resume") throw new UsageError("用法：pisa executor pause|resume");
      return await act(
        io,
        args,
        mgmtFor(cfg).post("/api/executor/pause", { confirm: true, paused: target === "pause" }),
      );
    }

    case "config": {
      const mgmt = mgmtFor(cfg);
      const setFile = flagString(args, "set");
      if (!setFile) {
        const current = await mgmt.get<Record<string, unknown>>("/api/config");
        if (args.flags.get("json")) json(io, current);
        else configHuman(io, current);
        return EXIT.ok;
      }
      if (!args.flags.get("yes")) throw new UsageError("保存配置会改写 pisa.json：请确认后加 --yes");
      if (!existsSync(setFile)) throw new UsageError(`找不到补丁文件：${setFile}`);
      const patch = JSON.parse(readFileSync(setFile, "utf8")) as unknown;
      const saved = await mgmt.post<{ ok: boolean; restartRequired?: boolean; message?: string }>("/api/config", {
        patch,
        confirm: true,
      });
      if (args.flags.get("json")) json(io, saved);
      else io.out(saved.message ?? "已保存");
      return saved.restartRequired ? EXIT.restart : EXIT.ok;
    }

    case "repos": {
      const payload = await mgmtFor(cfg).get<{ repos: Array<{ alias: string; path: string; allowed: boolean }> }>(
        "/api/repos",
      );
      if (args.flags.get("json")) json(io, payload.repos);
      else if (payload.repos.length === 0) io.out("(配置里没有仓库)");
      else for (const r of payload.repos) io.out(`${r.alias} · ${r.allowed ? "可用" : "未授权"} · ${r.path}`);
      return EXIT.ok;
    }

    default:
      throw new UsageError(`未知命令：${command}；pisa help 查看用法`);
  }
}

function configHuman(io: Io, cfg: Record<string, unknown>): void {
  const repos = Array.isArray(cfg.repos) ? (cfg.repos as Array<{ alias: string; path: string }>) : [];
  const worker = cfg.worker as { adapter?: string; concurrency?: number; timeoutSec?: number } | undefined;
  const schedules = Array.isArray(cfg.schedules) ? cfg.schedules.length : 0;
  io.out(`配置：${String(cfg.path ?? "-")}`);
  for (const r of repos) io.out(`仓库：${r.alias} · ${r.path}`);
  if (worker) io.out(`执行器：${worker.adapter ?? "-"} · 并发 ${worker.concurrency ?? "-"} · 超时 ${worker.timeoutSec ?? "-"}s`);
  io.out(`计划任务：${schedules} 条`);
}

export async function runCli(argv: string[], io: Partial<Io> = {}): Promise<number> {
  const merged: Io = { ...defaultIo, ...io };
  try {
    return await dispatch(merged, argv);
  } catch (err) {
    merged.err(err instanceof Error ? err.message : String(err));
    if (err instanceof UnconfiguredError || err instanceof UnauthorizedError) return EXIT.unconfigured;
    if (err instanceof UsageError || err instanceof UnreachableError || err instanceof ApiError) return EXIT.component;
    return EXIT.component;
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
