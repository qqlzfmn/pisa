#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { ApiClient, ApiError, type RewindResponse } from "./api-client";
import { findConfig, loadConfig, type Config } from "./config";
import type { CreateTicketInput, StateView, TaskView } from "./management";
import { continuationContext } from "./task-context";
import { formatDuration, formatStatusBoard, preview, type BoardData } from "./status";

/** 退出码：脚本据此分支，不要在版本间随意改语义 */
const EXIT = {
  ok: 0,
  restart: 1,
  error: 2,
  setup: 3,
} as const;

const STATUSES = ["queued", "running", "paused", "succeeded", "failed", "cancelled", "rewound"] as const;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "rewound"]);

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
};

class UsageError extends Error {}
class SetupError extends Error {}

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

function resolveConfigPath(args: ParsedArgs): string {
  return flagString(args, "config") ?? process.env.PISA_CONFIG ?? findConfig(process.cwd());
}

function loadCfg(args: ParsedArgs): { cfg: Config } {
  const configPath = resolveConfigPath(args);
  if (!existsSync(configPath)) throw new SetupError(`找不到配置文件：${configPath}；可用 --config 指定`);
  return { cfg: loadConfig(configPath) };
}

/** 除 repos/help 外的命令都要求管理接口已启用并拿到 api.json */
function connect(args: ParsedArgs): { cfg: Config; client: ApiClient } {
  const { cfg } = loadCfg(args);
  if (!cfg.api.enabled) throw new SetupError("管理接口未启用：在 pisa.config.json 里设置 api.enabled=true");
  return { cfg, client: ApiClient.fromState(cfg.stateDir) };
}

function cliRequester(args: ParsedArgs): string {
  return flagString(args, "requester") ?? process.env.PISA_CLI_USER ?? process.env.USER ?? "local";
}

/** 服务端的 invalid 是配置/权限/仓库这类“待配置”问题，与用法错误区分 */
function exitOf(err: ApiError): number {
  return err.code === "invalid" ? EXIT.setup : err.exit;
}

function emitTicket(io: Io, args: ParsedArgs, task: TaskView, message: string): void {
  if (args.flags.get("json")) {
    json(io, { ...task, message });
    return;
  }
  io.out(`${task.id} · ${task.status} · ${task.repo}`);
  io.out(message);
}

async function waitTask(io: Io, client: ApiClient, args: ParsedArgs, id: string): Promise<number> {
  const timeoutSec = flagNumber(args, "timeout") ?? 1800;
  const intervalMs = Math.max(10, flagNumber(args, "interval") ?? 1000);
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const task = await client.ticket(id);
    if (TERMINAL.has(task.status)) {
      if (args.flags.get("json")) json(io, task);
      else {
        io.out(`${task.id} · ${task.status}`);
        if (task.summary) io.out(task.summary);
        if (task.error) io.err(task.error);
        if (task.prUrl) io.out(task.prUrl);
      }
      return task.status === "succeeded" ? EXIT.ok : EXIT.error;
    }
    if (task.status === "paused") {
      if (args.flags.get("json")) json(io, task);
      else io.err(`任务 ${task.id} 已暂停，恢复请在 pisa 会话里用 resume <任务号>`);
      return EXIT.error;
    }
    if (Date.now() >= deadline) {
      if (args.flags.get("json")) json(io, { id: task.id, status: task.status, timeout: true });
      else io.err(`等待超时，任务仍在 ${task.status}：${task.id}`);
      return EXIT.error;
    }
    await Bun.sleep(intervalMs);
  }
}

function taskHuman(io: Io, cfg: Config, task: TaskView): void {
  const rows: Array<[string, string]> = [
    ["任务", task.id],
    ["状态", task.status],
    ["仓库", task.repo],
    ["需求", preview(task.prompt, 120)],
    ["分支", task.branch ?? "(未创建)"],
    ["PR", task.prUrl ?? "(无)"],
    ["创建", new Date(task.createdAt).toISOString()],
    ["耗时", task.startedAt ? formatDuration((task.endedAt ?? Date.now()) - task.startedAt) : "-"],
    ["日志", `${cfg.stateDir}/logs/${task.id}.log`],
  ];
  if (task.summary) rows.push(["摘要", task.summary]);
  if (task.error) rows.push(["错误", task.error]);
  for (const [k, v] of rows) io.out(`${k}：${v}`);
}

function board(state: StateView): BoardData {
  return {
    running: state.running,
    queued: state.queued,
    finished: state.finished,
    counts: state.counts,
    total: state.total,
  };
}

function printRewind(io: Io, report: RewindResponse): void {
  const { plan } = report;
  if (!report.results) {
    io.out(`rewind 预览 · ${plan.task.id}`);
    io.out(`状态：${plan.task.status} · 仓库 ${plan.task.repo}`);
    io.out(`合并：${plan.merge}`);
    if (plan.actions.length > 0) {
      io.out("");
      io.out(`将执行（${plan.actions.length}）`);
      plan.actions.forEach((a, i) => io.out(`${i + 1}. ${a.label}`));
    } else {
      io.out("");
      io.out("没有可撤销的副作用。");
    }
    if (plan.irreversible.length > 0) io.out(["", "不可撤销", ...plan.irreversible.map((s) => `- ${s}`)].join("\n"));
    if (plan.notes.length > 0) io.out(["", "保留", ...plan.notes.map((s) => `- ${s}`)].join("\n"));
    io.out("");
    io.out("加 --yes 执行。");
    return;
  }
  for (const r of report.results) io.out(`${r.ok ? "✔" : "✘"} ${r.label}${r.ok ? "" : `：${r.error ?? "失败"}`}`);
  io.out("");
  io.out(
    report.rewound
      ? `已撤销 · ${plan.task.id}`
      : `未完成撤销 · ${plan.task.id}${report.results.every((r) => r.ok) ? "（合并状态未知，未标记）" : ""}`,
  );
}

export function helpText(): string {
  return `pisa CLI：通过本机管理接口操作 pisa 守护进程

用法：
  pisa run <需求> [--repo 别名] [--requester 用户] [--event-id 键] [--wait] [--json]
  pisa continue <任务号> <新要求> [--wait] [--json]
  pisa wait <任务号> [--timeout 秒] [--interval 毫秒] [--json]
  pisa status [--json]
  pisa list [--repo 别名] [--status 状态] [--limit N] [--pr 编号] [--json]
  pisa show <任务号> [--json]
  pisa logs <任务号> [--tail N] [--json]
  pisa retry <任务号>
  pisa stop <任务号>
  pisa merge <任务号>
  pisa rewind <任务号> [--yes] [--json]
  pisa executor pause|resume
  pisa repos [--json]

全局选项：
  --config <path>   配置文件；默认 PISA_CONFIG，否则从当前目录向上找 pisa.config.json

退出码：
  0 成功
  1 需要重启或重新连接：管理接口不可达、令牌失效、status 检测到心跳过期
  2 命令失败：任务失败或取消、等待超时、服务端拒绝、用法错误
  3 待配置：配置文件缺失、管理接口未启用、仓库未授权或不可用
`;
}

async function dispatch(io: Io, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positional[0] ?? (args.flags.get("help") ? "help" : undefined);
  if (!command || command === "help" || args.flags.get("help")) {
    io.out(helpText());
    return EXIT.ok;
  }

  switch (command) {
    case "repos": {
      const { cfg } = loadCfg(args);
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

    case "run": {
      const prompt = args.positional.slice(1).join(" ").trim();
      if (!prompt) throw new UsageError("run 需要需求正文");
      const { client } = connect(args);
      const input: CreateTicketInput = {
        prompt,
        repo: flagString(args, "repo") ?? process.env.PISA_REPO,
        requester: cliRequester(args),
        eventId: flagString(args, "event-id"),
      };
      const created = await client.create({ ...input });
      const state = await client.state();
      if (!(args.flags.get("wait") && args.flags.get("json"))) {
        emitTicket(
          io,
          args,
          created.ticket,
          created.created
            ? state.daemon.alive
              ? "已入队"
              : "已入队，但守护进程心跳已过期；请确认 pisa 正在运行"
            : "事件已存在，返回原任务",
        );
      }
      if (!state.daemon.alive) io.err("警告：没有检测到运行中的 pisa 守护进程，任务会一直排队。");
      return args.flags.get("wait") ? await waitTask(io, client, args, created.ticket.id) : EXIT.ok;
    }

    case "continue": {
      const parentId = args.positional[1];
      const brief = args.positional.slice(2).join(" ").trim();
      if (!parentId || !brief) throw new UsageError("用法：pisa continue <任务号> <新要求>");
      const { client } = connect(args);
      const parent = await client.ticket(parentId);
      if (!parent.branch) throw new UsageError(`任务 ${parent.id} 没有可续跑的分支`);
      const created = await client.create({
        prompt: brief,
        repo: parent.repo,
        requester: cliRequester(args),
        eventId: flagString(args, "event-id"),
        baseRef: parent.branch,
        context: continuationContext(parent),
        prUrl: parent.prUrl ?? undefined,
      });
      emitTicket(io, args, created.ticket, created.created ? "已入队" : "事件已存在，返回原任务");
      return args.flags.get("wait") ? await waitTask(io, client, args, created.ticket.id) : EXIT.ok;
    }

    case "wait": {
      const id = args.positional[1];
      if (!id) throw new UsageError("用法：pisa wait <任务号>");
      const { client } = connect(args);
      return await waitTask(io, client, args, id);
    }

    case "status": {
      const { client } = connect(args);
      const state = await client.state();
      if (args.flags.get("json")) {
        json(io, state);
        return EXIT.ok;
      }
      io.out(formatStatusBoard(board(state)));
      const beat = state.daemon.ageMs === null ? "无心跳记录" : `最后心跳 ${formatDuration(state.daemon.ageMs)} 前`;
      io.out(`守护进程：${state.daemon.alive ? "运行中" : "未运行"}（${beat}）`);
      if (state.executor.paused) io.out("执行器：已暂停（pisa executor resume 恢复）");
      // status 是脚本探活入口：心跳过期就是“需要重启”，与 GET /state 的 daemon.alive 同一判定
      return state.daemon.alive ? EXIT.ok : EXIT.restart;
    }

    case "list": {
      const status = flagString(args, "status");
      if (status && !STATUSES.includes(status as (typeof STATUSES)[number])) {
        throw new UsageError(`未知状态：${status}；可选 ${STATUSES.join("/")}`);
      }
      const { client } = connect(args);
      const tasks = await client.list({
        repo: flagString(args, "repo"),
        status,
        limit: flagNumber(args, "limit") ?? 20,
        pr: flagNumber(args, "pr"),
        githubRepo: flagString(args, "github-repo"),
      });
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
      const id = args.positional[1];
      if (!id) throw new UsageError("用法：pisa show <任务号>");
      const { cfg, client } = connect(args);
      const task = await client.ticket(id);
      if (args.flags.get("json")) json(io, task);
      else taskHuman(io, cfg, task);
      return EXIT.ok;
    }

    case "logs": {
      const id = args.positional[1];
      if (!id) throw new UsageError("用法：pisa logs <任务号> [--tail N]");
      const { client } = connect(args);
      const count = Math.max(1, Math.floor(flagNumber(args, "tail") ?? 80));
      const lines = await client.logs(id, count);
      if (args.flags.get("json")) json(io, lines);
      else io.out(lines.length > 0 ? lines.join("\n") : "(日志为空)");
      return EXIT.ok;
    }

    case "retry": {
      const id = args.positional[1];
      if (!id) throw new UsageError("用法：pisa retry <任务号>");
      const { client } = connect(args);
      const created = await client.retry(id);
      emitTicket(io, args, created.ticket, created.created ? "已重试入队" : "该任务已重试过，返回原任务");
      return EXIT.ok;
    }

    case "stop": {
      const id = args.positional[1];
      if (!id) throw new UsageError("用法：pisa stop <任务号>");
      const { client } = connect(args);
      const result = await client.stop(id);
      io.out(result.state === "cancelling" ? `${result.message}（Worker 在下一个检查点退出）` : result.message);
      return EXIT.ok;
    }

    case "merge": {
      const id = args.positional[1];
      if (!id) throw new UsageError("用法：pisa merge <任务号>");
      const { client } = connect(args);
      const result = await client.merge(id);
      if (!result.ok) {
        io.err(`未合并 · ${id}`);
        io.err(result.detail);
        return EXIT.error;
      }
      io.out(`已合并 · ${id}`);
      io.out(result.detail);
      io.out("若没有看护进程，请重启 pisa 使改动生效。");
      return EXIT.ok;
    }

    case "rewind": {
      const id = args.positional[1];
      if (!id) throw new UsageError("用法：pisa rewind <任务号> [--yes]");
      const { client } = connect(args);
      const report = await client.rewind(id, Boolean(args.flags.get("yes")));
      if (args.flags.get("json")) json(io, report);
      else printRewind(io, report);
      return EXIT.ok;
    }

    case "executor": {
      const action = args.positional[1];
      if (action !== "pause" && action !== "resume") throw new UsageError("用法：pisa executor pause|resume");
      const { client } = connect(args);
      const result = await client.pause(action === "pause");
      io.out(result.paused ? "执行器已暂停" : "执行器已恢复运行");
      return EXIT.ok;
    }

    default:
      throw new UsageError(`未知命令：${command}；pisa help 查看用法`);
  }
}

export async function runCli(argv: string[], io: Partial<Io> = {}): Promise<number> {
  const merged: Io = { ...defaultIo, ...io };
  try {
    return await dispatch(merged, argv);
  } catch (err) {
    if (err instanceof UsageError) {
      merged.err(err.message);
      return EXIT.error;
    }
    if (err instanceof SetupError) {
      merged.err(err.message);
      return EXIT.setup;
    }
    if (err instanceof ApiError) {
      merged.err(err.message);
      return exitOf(err);
    }
    merged.err(err instanceof Error ? err.message : String(err));
    return EXIT.error;
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
