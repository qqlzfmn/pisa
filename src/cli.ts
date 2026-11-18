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
import { daemonState, preview, taskJson } from "./status";
import { ApiUnreachable } from "./api-client";
import {
  EXIT,
  STATUSES,
  TERMINAL,
  ConfigError,
  NotFoundError,
  NotRunnableError,
  RestartError,
  UsageError,
  defaultIo,
  flagNumber,
  flagString,
  json,
  parseArgs,
  type Io,
  type ParsedArgs,
} from "./cli-args";
import { runRemote } from "./cli-manage";



function openState(configPath: string): { cfg: Config; store: Store } {
  const cfg = loadConfig(configPath);
  return { cfg, store: new Store(join(cfg.stateDir, "pisa.db")) };
}

function resolveConfigPath(args: ParsedArgs): string {
  return flagString(args, "config") ?? process.env.PISA_CONFIG ?? findConfig(process.cwd());
}

function repoForTask(cfg: Config, alias: string | undefined) {
  const repo = repoByAlias(cfg, alias);
  if (!repo) throw new ConfigError(alias ? `未知仓库别名：${alias}` : "配置里没有仓库，请先设置 repos");
  if (cfg.whitelist.repos.length > 0 && !cfg.whitelist.repos.includes(repo.alias)) {
    throw new ConfigError(`无权限：仓库 ${repo.alias} 不在 whitelist.repos`);
  }
  if (!isGitRepo(repo.path)) throw new ConfigError(`仓库路径不是 git 仓库：${repo.path}`);
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
      return task.status === "succeeded" ? EXIT.ok : task.status === "failed" ? EXIT.component : EXIT.notRunnable;
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

export function helpText(): string {
  return `pisa CLI：向本地 pisa 守护进程提交任务并查询结果

用法：
  pisa run <需求> [--repo 别名] [--timeout 秒] [--json]
  pisa task <需求> [--repo 别名] [--wait] [--json]
  pisa continue <任务号> <新要求> [--wait] [--json]
  pisa wait <任务号> [--timeout 秒] [--json]
  pisa status [--json]
  pisa list [--repo 别名] [--status 状态] [--limit N] [--pr 编号] [--json]
  pisa show <任务号> [--json]
  pisa logs <任务号> [--tail N]
  pisa stop <任务号> | retry <任务号> | merge <任务号> | rewind <任务号> [--yes]
  pisa pause | resume
  pisa repos [--json]

全局选项：
  --config <path>   配置文件；默认 PISA_CONFIG，否则从当前目录向上找 pisa.config.json

管理接口：
  地址与 token 由守护进程写入 stateDir/api.json；PISA_API_URL / PISA_API_TOKEN 可覆盖

退出码：
  0 正常    1 需重启    2 部件错误    3 待配置
  4 用法    5 找不到    6 不可运行    7 等待超时
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
    throw new ConfigError(`找不到配置文件：${configPath}；可用 --config 指定`);
  }
  const { cfg, store } = openState(configPath);
  try {
    switch (command) {
      case "run":
      case "status":
      case "show":
      case "logs":
      case "stop":
      case "retry":
      case "merge":
      case "rewind":
      case "pause":
      case "resume": {
        const code = await runRemote(command, io, cfg, args);
        if (code === null) throw new UsageError(`未知命令：${command}`);
        return code;
      }

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

export async function runCli(argv: string[], io: Partial<Io> = {}): Promise<number> {
  const merged: Io = { ...defaultIo, ...io };
  try {
    return await dispatch(merged, argv);
  } catch (err) {
    if (err instanceof ApiUnreachable) {
      merged.err(err.message);
      return EXIT.restart;
    }
    if (err instanceof RestartError) {
      merged.err(err.message);
      return EXIT.restart;
    }
    if (err instanceof ConfigError) {
      merged.err(err.message);
      return EXIT.config;
    }
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
    return EXIT.component;
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
