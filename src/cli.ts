#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { findConfig, loadConfig, repoByAlias, type Config } from "./config";
import { Store } from "./store";
import { isGitRepo } from "./git";
import type { Task, TaskStatus } from "./types";
import { newTaskId } from "./ids";
import { makeTrigger } from "./trigger";
import { continuationContext } from "./task-context";
import { readTail, tailLines } from "./log";
import { daemonState, formatDuration, formatStatusBoard, preview, statusSnapshot, taskJson } from "./status";
import { windowMetrics } from "./metrics";
import { stageText } from "./stage";

/** 退出码：脚本据此分支，不要在版本间随意改语义 */
const EXIT = {
  ok: 0,
  taskFailed: 1,
  usage: 2,
  notFound: 3,
  notRunnable: 4,
  timeout: 5,
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

const BOOL_FLAGS = new Set(["json", "wait", "help"]);
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

function openState(configPath: string): { cfg: Config; store: Store } {
  const cfg = loadConfig(configPath);
  return { cfg, store: new Store(join(cfg.stateDir, "pisa.db")) };
}

function resolveConfigPath(args: ParsedArgs): string {
  return flagString(args, "config") ?? process.env.PISA_CONFIG ?? findConfig(process.cwd());
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

function enqueue(io: Io, store: Store, args: ParsedArgs, task: Task): number {
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
    return EXIT.ok;
  }

  const daemon = daemonState(store);
  // --wait --json 只输出最终任务，避免两个 JSON 拼在一起无法解析
  if (!(args.flags.get("wait") && args.flags.get("json"))) {
    emitTask(io, args, task, daemon.alive ? "已入队" : "已入队，但守护进程心跳已过期；请确认 pisa 正在运行");
  }
  if (!daemon.alive) io.err("警告：没有检测到运行中的 pisa 守护进程，任务会一直排队。");
  return EXIT.ok;
}

function emitTask(io: Io, args: ParsedArgs, task: Task, message: string): void {
  if (args.flags.get("json")) {
    json(io, { ...taskJson(task), message });
    return;
  }
  io.out(`${task.id} · ${task.status} · ${task.repo}`);
  io.out(message);
}

async function waitTask(io: Io, store: Store, args: ParsedArgs, id: string): Promise<number> {
  const timeoutSec = flagNumber(args, "timeout") ?? 1800;
  const intervalMs = Math.max(10, flagNumber(args, "interval") ?? 1000);
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const task = store.get(id);
    if (!task) {
      io.err(`找不到任务 ${id}`);
      return EXIT.notFound;
    }
    if (TERMINAL.includes(task.status)) {
      if (args.flags.get("json")) json(io, taskJson(task));
      else {
        io.out(`${task.id} · ${task.status}`);
        if (task.summary) io.out(task.summary);
        if (task.error) io.err(task.error);
        if (task.prUrl) io.out(task.prUrl);
      }
      return task.status === "succeeded" ? EXIT.ok : task.status === "failed" ? EXIT.taskFailed : EXIT.notRunnable;
    }
    if (task.status === "paused") {
      if (args.flags.get("json")) json(io, taskJson(task));
      else io.err(`任务 ${task.id} 已暂停，恢复请在 pisa 会话里用 resume <任务号>`);
      return EXIT.notRunnable;
    }
    if (Date.now() >= deadline) {
      if (args.flags.get("json")) json(io, { id: task.id, status: task.status, timeout: true });
      else io.err(`等待超时，任务仍在 ${task.status}：${task.id}`);
      return EXIT.timeout;
    }
    await Bun.sleep(intervalMs);
  }
}

function taskHuman(io: Io, task: Task, logPath: string): void {
  const rows: Array<[string, string]> = [
    ["任务", task.id],
    ["状态", task.status],
    ["阶段", stageText(task)],
    ["仓库", task.repo],
    ["需求", preview(task.prompt, 120)],
    ["分支", task.branch ?? "(未创建)"],
    ["PR", task.prUrl ?? "(无)"],
    ["创建", new Date(task.createdAt).toISOString()],
    ["耗时", task.startedAt ? formatDuration((task.endedAt ?? Date.now()) - task.startedAt) : "-"],
    ["日志", logPath],
  ];
  if (task.summary) rows.push(["摘要", task.summary]);
  if (task.error) rows.push(["错误", task.error]);
  for (const [k, v] of rows) io.out(`${k}：${v}`);
}

export function helpText(): string {
  return `pisa CLI：向本地 pisa 守护进程提交任务并查询结果

用法：
  pisa task <需求> [--repo 别名] [--wait] [--json]
  pisa continue <任务号> <新要求> [--wait] [--json]
  pisa wait <任务号> [--timeout 秒] [--json]
  pisa status [--json]
  pisa list [--repo 别名] [--status 状态] [--limit N] [--pr 编号] [--json]
  pisa show <任务号> [--json]
  pisa logs <任务号> [--tail N]
  pisa cancel <任务号>
  pisa repos [--json]

全局选项：
  --config <path>   配置文件；默认 PISA_CONFIG，否则从当前目录向上找 pisa.config.json

退出码：
  0 成功    1 任务失败或命令被拒    2 用法/配置错误
  3 找不到任务    4 任务不可运行（暂停/取消/撤销）    5 等待超时
`;
}

async function dispatch(io: Io, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positional[0] ?? (args.flags.get("help") ? "help" : undefined);
  if (!command || command === "help" || args.flags.get("help")) {
    io.out(helpText());
    return EXIT.ok;
  }

  const configPath = resolveConfigPath(args);
  if (!existsSync(configPath)) {
    throw new UsageError(`找不到配置文件：${configPath}；可用 --config 指定`);
  }
  const { cfg, store } = openState(configPath);
  try {
    switch (command) {
      case "task": {
        const brief = args.positional.slice(1).join(" ").trim();
        if (!brief) throw new UsageError("task 需要需求正文");
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
        const code = enqueue(io, store, args, task);
        return code === EXIT.ok && args.flags.get("wait") ? await waitTask(io, store, args, task.id) : code;
      }

      case "continue": {
        const parentId = args.positional[1];
        const brief = args.positional.slice(2).join(" ").trim();
        if (!parentId || !brief) throw new UsageError("用法：pisa continue <任务号> <新要求>");
        const parent = store.get(parentId);
        if (!parent) throw new NotFoundError(`找不到任务 ${parentId}`);
        if (!parent.branch) throw new UsageError(`任务 ${parent.id} 没有可续跑的分支`);
        const task = newCliTask({
          id: newTaskId(),
          requester: cliRequester(args),
          repo: parent.repo,
          prompt: brief,
          baseRef: parent.branch,
          context: continuationContext(parent),
          prUrl: parent.prUrl,
        });
        const code = enqueue(io, store, args, task);
        return code === EXIT.ok && args.flags.get("wait") ? await waitTask(io, store, args, task.id) : code;
      }

      case "wait": {
        const id = args.positional[1];
        if (!id) throw new UsageError("用法：pisa wait <任务号>");
        return await waitTask(io, store, args, id);
      }

      case "status": {
        const daemon = daemonState(store);
        if (args.flags.get("json")) {
          const snapshot = statusSnapshot(store);
          json(io, {
            daemon,
            counts: snapshot.counts,
            total: snapshot.total,
            running: snapshot.running.map(taskJson),
            queued: snapshot.queued.map(taskJson),
            finished: snapshot.finished.map(taskJson),
            last24h: windowMetrics(store),
          });
          return EXIT.ok;
        }
        io.out(formatStatusBoard(store));
        const beat = daemon.ageMs === null ? "无心跳记录" : `最后心跳 ${formatDuration(daemon.ageMs)} 前`;
        io.out(`守护进程：${daemon.alive ? "运行中" : "未运行"}（${beat}）`);
        return EXIT.ok;
      }

      case "list": {
        const status = flagString(args, "status");
        if (status && !STATUSES.includes(status as TaskStatus)) {
          throw new UsageError(`未知状态：${status}；可选 ${STATUSES.join("/")}`);
        }
        const limit = flagNumber(args, "limit") ?? 20;
        const pr = flagNumber(args, "pr");
        const tasks = pr !== undefined
          ? store.tasksByPr(pr, flagString(args, "github-repo"), limit)
          : store.listTasks({ repo: flagString(args, "repo"), status: status as TaskStatus | undefined, limit });
        if (args.flags.get("json")) {
          json(io, tasks.map(taskJson));
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
        const id = args.positional[1];
        if (!id) throw new UsageError("用法：pisa show <任务号>");
        const task = store.get(id);
        if (!task) throw new NotFoundError(`找不到任务 ${id}`);
        if (args.flags.get("json")) json(io, taskJson(task));
        else taskHuman(io, task, join(cfg.stateDir, "logs", `${task.id}.log`));
        return EXIT.ok;
      }

      case "logs": {
        const id = args.positional[1];
        if (!id) throw new UsageError("用法：pisa logs <任务号> [--tail N]");
        const path = join(cfg.stateDir, "logs", `${id}.log`);
        if (!existsSync(path)) throw new NotFoundError(`任务 ${id} 还没有日志：${path}`);
        const count = Math.max(1, Math.floor(flagNumber(args, "tail") ?? 80));
        const lines = tailLines(readTail(path), Math.max(1, count));
        io.out(lines.length > 0 ? lines.join("\n") : "(日志为空)");
        return EXIT.ok;
      }

      case "cancel": {
        const id = args.positional[1];
        if (!id) throw new UsageError("用法：pisa cancel <任务号>");
        const task = store.get(id);
        if (!task) throw new NotFoundError(`找不到任务 ${id}`);
        if (task.status === "running") {
          store.requestCancel(id);
          io.out(`已请求取消：${id}（Worker 在下一个检查点退出）`);
          return EXIT.ok;
        }
        if (task.status !== "queued" && task.status !== "paused") {
          throw new NotRunnableError(`任务已处于 ${task.status}，无法取消`);
        }
        if (!store.transition(id, "cancelled", { endedAt: Date.now() })) {
          throw new NotRunnableError(`任务状态已变化，取消失败：${id}`);
        }
        io.out(`已取消：${id}`);
        return EXIT.ok;
      }

      case "repos": {
        const rows = cfg.repos.map((r) => ({
          alias: r.alias,
          path: r.path,
          remote: r.remote ?? null,
          baseBranch: r.baseBranch ?? null,
          allowed: cfg.whitelist.repos.length === 0 || cfg.whitelist.repos.includes(r.alias),
        }));
        if (args.flags.get("json")) json(io, rows);
        else if (rows.length === 0) io.out("(配置里没有仓库)");
        else for (const r of rows) io.out(`${r.alias} · ${r.allowed ? "可用" : "未授权"} · ${r.path}`);
        return EXIT.ok;
      }

      default:
        throw new UsageError(`未知命令：${command}；pisa help 查看用法`);
    }
  } finally {
    store.close();
  }
}

class NotFoundError extends Error {}
class NotRunnableError extends Error {}

export async function runCli(argv: string[], io: Partial<Io> = {}): Promise<number> {
  const merged: Io = { ...defaultIo, ...io };
  try {
    return await dispatch(merged, argv);
  } catch (err) {
    if (err instanceof NotFoundError) {
      merged.err(err.message);
      return EXIT.notFound;
    }
    if (err instanceof NotRunnableError) {
      merged.err(err.message);
      return EXIT.notRunnable;
    }
    if (err instanceof UsageError) {
      merged.err(err.message);
      return EXIT.usage;
    }
    merged.err(err instanceof Error ? err.message : String(err));
    return EXIT.usage;
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
