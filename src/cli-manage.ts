import { repoByAlias, type Config } from "./config";
import type { TaskStatus } from "./types";
import { ApiClient, apiTarget, type ApiReply } from "./api-client";
import type { BoardTask, StatePayload, TicketPayload } from "./manager";
import { formatRewindPlan, type RewindPlan } from "./rewind";
import { formatDuration, preview } from "./status";
import {
  EXIT,
  ConfigError,
  NotFoundError,
  RestartError,
  TERMINAL,
  UsageError,
  flagNumber,
  flagString,
  json,
  type Io,
  type ParsedArgs,
} from "./cli-args";

/** 写操作的接口正文：只声明 CLI 会读的字段 */
interface StopBody {
  ok: boolean;
  status: TaskStatus | null;
  message: string;
}

interface RewindBody {
  ok: boolean;
  status?: TaskStatus | null;
  message?: string;
  plan?: RewindPlan;
}

/** 管理接口的退出码映射：状态码即语义，正文只用于提示 */
function apiExit(reply: ApiReply): number {
  if (reply.status < 300) return EXIT.ok;
  if (reply.status === 400 || reply.status === 401 || reply.status === 403) return EXIT.config;
  if (reply.status === 404) return EXIT.notFound;
  if (reply.status === 409) return EXIT.notRunnable;
  return EXIT.component;
}

function apiFailure(io: Io, reply: ApiReply, fallback: string): number {
  const body = reply.body as { error?: unknown; message?: unknown } | null;
  const detail = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
  io.err(detail || `${fallback}（HTTP ${reply.status}）`);
  return apiExit(reply);
}

function apiFor(io: Io, cfg: Config): ApiClient {
  const target = io.api ?? apiTarget(cfg.stateDir);
  if (!target) {
    throw new RestartError("管理接口未就绪：找不到 api.json，守护进程可能没启动；重启 pisa 后再试。");
  }
  return new ApiClient(target);
}

function taskLines(task: BoardTask): string[] {
  const at = task.startedAt ? task.duration : "-";
  const rows: Array<[string, string]> = [
    ["任务", task.id],
    ["状态", `${task.status}（${task.statusLabel}）`],
    ["阶段", `${task.stage}（${task.stageLabel}）`],
    ["仓库", task.repo],
    ["需求", preview(task.prompt, 120)],
    ["分支", task.branch ?? "(未创建)"],
    ["PR", task.prUrl ?? "(无)"],
    ["创建", new Date(task.createdAt).toISOString()],
    ["耗时", at],
  ];
  if (task.summary) rows.push(["摘要", task.summary]);
  if (task.error) rows.push(["错误", task.error]);
  return rows.map(([k, v]) => `${k}：${v}`);
}

function stateLines(state: StatePayload): string[] {
  const lines: string[] = [];
  lines.push(`运行中（${state.counts.running}）`);
  if (state.running.length === 0) lines.push("  (无)");
  for (const t of state.running) lines.push(`  ${t.id} · ${t.repo} · ${t.stageLabel} · ${preview(t.prompt, 60)}`);
  lines.push(`排队（${state.counts.queued}）`);
  if (state.queued.length === 0) lines.push("  (无)");
  for (const t of state.queued) lines.push(`  ${t.id} · ${t.repo} · ${t.stageLabel} · ${preview(t.prompt, 60)}`);
  lines.push("最近完成");
  if (state.finished.length === 0) lines.push("  (无)");
  for (const t of state.finished) lines.push(`  ${t.id} · ${t.statusLabel} · ${t.repo} · ${preview(t.prompt, 60)}`);
  const m = state.last24h;
  const rate = m.successRate === null ? "" : ` · 成功率 ${Math.round(m.successRate * 100)}%`;
  lines.push(`最近 24h：完成 ${m.finished} · 成功 ${m.succeeded} · 失败 ${m.failed}${rate}`);
  lines.push(`执行器：${state.executor.paused ? "已暂停" : "运行中"} · 并发 ${state.executor.running}/${state.executor.concurrency}`);
  const beat = state.daemon.ageMs === null ? "无心跳记录" : `最后心跳 ${formatDuration(state.daemon.ageMs)} 前`;
  lines.push(`守护进程：${state.daemon.alive ? "运行中" : "未运行"}（${beat}）`);
  return lines;
}

/** 等待远端任务收尾：轮询 /tickets/:id，直到终态或超时 */
async function waitRemote(io: Io, client: ApiClient, id: string, args: ParsedArgs): Promise<number> {
  const timeoutSec = flagNumber(args, "timeout") ?? 1800;
  const intervalMs = Math.max(10, flagNumber(args, "interval") ?? 1000);
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const reply = await client.get<TicketPayload>(`/tickets/${id}`);
    if (reply.status === 404) throw new NotFoundError(`找不到任务 ${id}`);
    if (reply.status !== 200) return apiFailure(io, reply, "查询任务失败");
    const task = reply.body.task;
    if (TERMINAL.includes(task.status) || task.status === "paused") {
      if (args.flags.get("json")) json(io, reply.body);
      else {
        io.out(`${task.id} · ${task.status}`);
        if (task.summary) io.out(task.summary);
        if (task.error) io.err(task.error);
        if (task.prUrl) io.out(task.prUrl);
      }
      if (task.status === "succeeded") return EXIT.ok;
      return task.status === "failed" ? EXIT.component : EXIT.notRunnable;
    }
    if (Date.now() >= deadline) {
      if (args.flags.get("json")) json(io, { id, status: task.status, timeout: true });
      else io.err(`等待超时，任务仍在 ${task.status}：${id}`);
      return EXIT.timeout;
    }
    await Bun.sleep(intervalMs);
  }
}

/** 管理接口命令：返回 null 表示该命令不归这里 */
export async function runRemote(command: string, io: Io, cfg: Config, args: ParsedArgs): Promise<number | null> {
  switch (command) {
      case "run": {
        const brief = args.positional.slice(1).join(" ").trim();
        if (!brief) throw new UsageError("用法：pisa run <需求> [--repo 别名] [--timeout 秒] [--json]");
        const repo = flagString(args, "repo") ?? process.env.PISA_REPO;
        if (repo && !repoByAlias(cfg, repo)) throw new ConfigError(`未知仓库别名：${repo}`);
        const client = apiFor(io, cfg);
        const reply = await client.post<{ ok: boolean; taskId: string | null; message: string }>("/api/tasks", { prompt: brief, repo });
        if (reply.status !== 200 || !reply.body.taskId) return apiFailure(io, reply, "派活失败");
        if (!args.flags.get("json")) io.out(`${reply.body.taskId} · 已入队`);
        return await waitRemote(io, client, reply.body.taskId, args);
      }

      case "status": {
        const reply = await apiFor(io, cfg).get<StatePayload>("/state");
        if (reply.status !== 200) return apiFailure(io, reply, "查询状态失败");
        const state = reply.body;
        if (args.flags.get("json")) json(io, state);
        else for (const line of stateLines(state)) io.out(line);
        if (!state.daemon.alive) {
          io.err("守护进程心跳已过期；重启 pisa 后再试。");
          return EXIT.restart;
        }
        return EXIT.ok;
      }

      case "show": {
        const id = args.positional[1];
        if (!id) throw new UsageError("用法：pisa show <任务号>");
        const reply = await apiFor(io, cfg).get<TicketPayload>(`/tickets/${id}`);
        if (reply.status !== 200) return apiFailure(io, reply, "查询任务失败");
        if (args.flags.get("json")) json(io, reply.body);
        else for (const line of taskLines(reply.body.task)) io.out(line);
        return EXIT.ok;
      }

      case "logs": {
        const id = args.positional[1];
        if (!id) throw new UsageError("用法：pisa logs <任务号> [--tail N]");
        const reply = await apiFor(io, cfg).get<TicketPayload>(`/tickets/${id}`);
        if (reply.status !== 200) return apiFailure(io, reply, "查询日志失败");
        const count = Math.max(1, flagNumber(args, "tail") ?? 80);
        const lines = args.flags.get("json") ? null : reply.body.logTail.slice(-count);
        if (lines === null) json(io, reply.body);
        else io.out(lines.length > 0 ? lines.join("\n") : "(日志为空)");
        return EXIT.ok;
      }

      case "stop": {
        const id = args.positional[1];
        if (!id) throw new UsageError("用法：pisa stop <任务号>");
        const reply = await apiFor(io, cfg).post<StopBody>(`/tickets/${id}/stop`);
        if (reply.status !== 200) return apiFailure(io, reply, "停止失败");
        if (args.flags.get("json")) json(io, reply.body);
        else io.out(reply.body.message || `已停止：${id}`);
        return EXIT.ok;
      }

      case "retry": {
        const id = args.positional[1];
        if (!id) throw new UsageError("用法：pisa retry <任务号>");
        const reply = await apiFor(io, cfg).post<{ ok: boolean; taskId: string | null; message: string }>(`/tickets/${id}/retry`);
        if (reply.status !== 200) return apiFailure(io, reply, "重试失败");
        if (args.flags.get("json")) json(io, reply.body);
        else io.out(`已重试：${id} → ${reply.body.taskId ?? "(未创建)"}`);
        return EXIT.ok;
      }

      case "merge": {
        const id = args.positional[1];
        if (!id) throw new UsageError("用法：pisa merge <任务号>");
        const reply = await apiFor(io, cfg).post<StopBody>(`/tickets/${id}/merge`, { confirm: true });
        if (reply.status !== 200) return apiFailure(io, reply, "合并失败");
        if (args.flags.get("json")) json(io, reply.body);
        else io.out(reply.body.message || `已合并：${id}`);
        return EXIT.ok;
      }

      case "rewind": {
        const id = args.positional[1];
        if (!id) throw new UsageError("用法：pisa rewind <任务号> [--yes]");
        const apply = Boolean(args.flags.get("yes"));
        const reply = await apiFor(io, cfg).post<RewindBody>(`/tickets/${id}/rewind`, { apply });
        if (reply.status !== 200) return apiFailure(io, reply, "撤销失败");
        if (args.flags.get("json")) json(io, reply.body);
        else if (reply.body.plan) io.out(formatRewindPlan(reply.body.plan, cfg.trigger));
        else io.out(reply.body.message || `已撤销：${id}`);
        return EXIT.ok;
      }

      case "pause":
      case "resume": {
        const reply = await apiFor(io, cfg).post<{ ok: boolean; executor: { paused: boolean; running: number; queued: number } }>(`/executor/${command}`);
        if (reply.status !== 200) return apiFailure(io, reply, "调整执行器失败");
        if (args.flags.get("json")) json(io, reply.body);
        else io.out(`执行器：${reply.body.executor.paused ? "已暂停" : "运行中"} · 运行 ${reply.body.executor.running} · 排队 ${reply.body.executor.queued}`);
        return EXIT.ok;
      }

    default:
      return null;
  }
}
