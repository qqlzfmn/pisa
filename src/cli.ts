import { existsSync } from "node:fs";
import { findConfig, loadConfig, repoByAlias, type Config } from "./config";
import {
  ApiClient,
  ApiError,
  ApiUnavailable,
  EXIT,
  apiBase,
  apiToken,
  type ActionResponse,
  type LogsResponse,
  type MergeResponse,
  type RewindResponse,
  type StateResponse,
  type SubmitResponse,
  type TicketDetailResponse,
  type TicketsResponse,
} from "./api";
import { STATUS_LABEL, formatDuration, formatStatusBoard, preview, type TicketJson } from "./status";

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

/** 用法错误：参数形状不对，脚本重试也不会变好 */
class UsageError extends Error {}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOL_FLAGS = ["json", "wait", "help", "yes", "force"] as const;
const VALUE_FLAGS = [
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
] as const;

const COMMANDS = [
  "run",
  "continue",
  "wait",
  "status",
  "list",
  "show",
  "logs",
  "stop",
  "retry",
  "merge",
  "rewind",
  "repos",
  "help",
] as const;

type Command = (typeof COMMANDS)[number];

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (!name) throw new UsageError(`无法解析参数：${arg}`);
    if ((BOOL_FLAGS as readonly string[]).includes(name)) {
      flags.set(name, true);
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(name)) throw new UsageError(`未知选项：--${name}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value === "")
      throw new UsageError(`--${name} 需要一个值`);
    flags.set(name, value);
  }
  return { positional, flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagNumber(args: ParsedArgs, name: string, fallback: number): number {
  const value = flagString(args, name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} 需要正数：${value}`);
  return n;
}

/** 任务一行：状态、阶段、仓库、需求；详情另加分支与链接 */
function formatTicket(t: TicketJson): string {
  const lines = [
    `任务：${t.id}`,
    `状态：${STATUS_LABEL[t.status]} · ${t.stage}（${t.stageLabel}）`,
    `仓库：${t.repo}`,
    `需求：${t.prompt}`,
  ];
  if (t.branch) lines.push(`分支：${t.branch}`);
  if (t.prUrl) lines.push(`PR：${t.prUrl}`);
  lines.push(`创建：${new Date(t.createdAt).toLocaleString("zh-CN")} · 耗时 ${t.duration}`);
  if (t.summary) lines.push(`摘要：${t.summary}`);
  if (t.error) lines.push(`错误：${t.error}`);
  return lines.join("\n");
}

function emitTicket(io: Io, t: TicketJson | null, json: boolean): void {
  if (!t) return;
  io.out(json ? JSON.stringify(t) : formatTicket(t));
}

async function waitTicket(client: ApiClient, id: string, args: ParsedArgs, io: Io): Promise<number> {
  const json = args.flags.has("json");
  const timeoutMs = flagNumber(args, "timeout", 1800) * 1000;
  const intervalMs = flagNumber(args, "interval", 1) * 1000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await client.get<TicketDetailResponse>(`/tickets/${encodeURIComponent(id)}`);
    const ticket = detail.ticket;
    const done = ticket.status === "succeeded" || ticket.status === "failed" || ticket.status === "cancelled";
    if (done || ticket.status === "rewound" || ticket.status === "paused") {
      emitTicket(io, ticket, json);
      if (ticket.status === "succeeded") return EXIT.ok;
      io.err(`任务 ${id} 结束于 ${ticket.status}${ticket.error ? `：${ticket.error}` : ""}`);
      return EXIT.failed;
    }
    if (Date.now() >= deadline) {
      emitTicket(io, ticket, json);
      io.err(`等待超时（${Math.round(timeoutMs / 1000)}s）· ${id}`);
      return EXIT.failed;
    }
    await Bun.sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
}

/** CLI 以本机用户身份办事：白名单按它校验，--requester 可覆盖（scheduler 等代跑场景） */
function cliRequester(args: ParsedArgs): string {
  return flagString(args, "requester") ?? process.env.PISA_CLI_USER ?? process.env.USER ?? "local";
}

function stateBoard(state: StateResponse): string {
  const beat =
    state.daemon.ageMs === null ? "从未上报" : `${formatDuration(state.daemon.ageMs)} 前`;
  const head = [
    `守护进程：${state.daemon.alive ? "运行中" : "心跳已过期"}（最后一次 ${beat}）`,
    `执行器：${state.executor.paused ? "已暂停" : "运行中"} · 并发 ${state.executor.active}/${state.executor.concurrency}`,
  ];
  return `${head.join("\n")}\n\n${formatStatusBoard(state)}`;
}

async function command(
  cmd: Command,
  rest: string[],
  args: ParsedArgs,
  cfg: Config,
  client: ApiClient,
  io: Io,
): Promise<number> {
  const json = args.flags.has("json");
  const repo = flagString(args, "repo");

  switch (cmd) {
    case "run": {
      const prompt = rest.join(" ").trim();
      if (!prompt) throw new UsageError("用法：pisa run <需求> [--repo 别名] [--event-id ID] [--wait] [--json]");
      const body = await client.post<SubmitResponse>("/tickets", {
        prompt,
        repo,
        eventId: flagString(args, "event-id"),
        requester: cliRequester(args),
      });
      const wait = args.flags.has("wait");
      if (!wait) emitTicket(io, body.ticket, json);
      if (!body.daemon.alive) {
        io.err("警告：守护进程心跳已过期，任务已入队但不会被执行；请启动 pisa 守护进程。");
        return EXIT.restart;
      }
      return wait ? waitTicket(client, body.ticketId, args, io) : EXIT.ok;
    }

    case "continue": {
      const [parentId, ...words] = rest;
      const prompt = words.join(" ").trim();
      if (!parentId || !prompt) throw new UsageError("用法：pisa continue <任务号> <新要求> [--wait] [--json]");
      const body = await client.post<SubmitResponse>("/tickets", {
        prompt,
        continueFrom: parentId,
        eventId: flagString(args, "event-id"),
        requester: cliRequester(args),
      });
      const wait = args.flags.has("wait");
      if (!wait) emitTicket(io, body.ticket, json);
      return wait ? waitTicket(client, body.ticketId, args, io) : EXIT.ok;
    }

    case "wait": {
      const id = rest[0];
      if (!id) throw new UsageError("用法：pisa wait <任务号> [--timeout 秒] [--interval 秒]");
      return waitTicket(client, id, args, io);
    }

    case "status": {
      const query = repo ? `?repo=${encodeURIComponent(repo)}` : "";
      let state: StateResponse;
      try {
        state = await client.get<StateResponse>(`/state${query}`);
      } catch (err) {
        if (!(err instanceof ApiUnavailable)) throw err;
        if (json) {
          io.out(
            JSON.stringify({
              ok: false,
              daemon: { alive: false, ageMs: null, lastBeat: null },
              error: err.message,
            }),
          );
        }
        io.err(`${err.message}；守护进程可能没启动。`);
        return EXIT.restart;
      }
      io.out(json ? JSON.stringify(state) : stateBoard(state));
      if (!state.daemon.alive) {
        io.err("守护进程心跳已过期：任务不会被领取，请重启 pisa。");
        return EXIT.restart;
      }
      return EXIT.ok;
    }

    case "list": {
      const params = new URLSearchParams();
      if (repo) params.set("repo", repo);
      const status = flagString(args, "status");
      if (status) {
        if (!(status in STATUS_LABEL)) throw new UsageError(`未知状态：${status}（可选 ${Object.keys(STATUS_LABEL).join("、")}）`);
        params.set("status", status);
      }
      const limit = flagString(args, "limit");
      if (limit) params.set("limit", limit);
      const pr = flagString(args, "pr");
      if (pr) params.set("pr", pr);
      const githubRepo = flagString(args, "github-repo");
      if (githubRepo) params.set("githubRepo", githubRepo);
      const query = params.toString();
      const body = await client.get<TicketsResponse>(`/tickets${query ? `?${query}` : ""}`);
      if (json) {
        io.out(JSON.stringify(body.tickets));
        return EXIT.ok;
      }
      if (body.tickets.length === 0) {
        io.out("(无)");
        return EXIT.ok;
      }
      for (const t of body.tickets) {
        io.out(`${t.id} · ${STATUS_LABEL[t.status]} · ${t.stage} · ${t.repo} · ${preview(t.prompt, 40)}`);
      }
      return EXIT.ok;
    }

    case "show": {
      const id = rest[0];
      if (!id) throw new UsageError("用法：pisa show <任务号> [--json]");
      const detail = await client.get<TicketDetailResponse>(`/tickets/${encodeURIComponent(id)}`);
      if (json) {
        io.out(JSON.stringify(detail));
        return EXIT.ok;
      }
      io.out(formatTicket(detail.ticket));
      if (detail.effects.length > 0) {
        io.out("\n副作用");
        for (const e of detail.effects) io.out(`${e.kind} · ${e.target}${e.detail ? ` · ${e.detail}` : ""}`);
      }
      if (detail.logTail.length > 0) {
        io.out("\n日志（尾部）");
        for (const line of detail.logTail) io.out(line);
      }
      return EXIT.ok;
    }

    case "logs": {
      const id = rest[0];
      if (!id) throw new UsageError("用法：pisa logs <任务号> [--tail N] [--json]");
      const tail = flagNumber(args, "tail", 80);
      const body = await client.get<LogsResponse>(`/tickets/${encodeURIComponent(id)}/logs?tail=${Math.trunc(tail)}`);
      if (json) io.out(JSON.stringify(body));
      else if (body.lines.length === 0) io.out("(无日志)");
      else for (const line of body.lines) io.out(line);
      return EXIT.ok;
    }

    case "stop": {
      const id = rest[0];
      if (!id) throw new UsageError("用法：pisa stop <任务号>");
      const body = await client.post<ActionResponse>(`/tickets/${encodeURIComponent(id)}/stop`);
      io.out(json ? JSON.stringify(body) : body.message);
      return EXIT.ok;
    }

    case "retry": {
      const id = rest[0];
      if (!id) throw new UsageError("用法：pisa retry <任务号>");
      const body = await client.post<ActionResponse>(`/tickets/${encodeURIComponent(id)}/retry`);
      io.out(json ? JSON.stringify(body) : body.message);
      return EXIT.ok;
    }

    case "merge": {
      const id = rest[0];
      if (!id) throw new UsageError("用法：pisa merge <任务号> [--force]");
      const body = await client.post<MergeResponse>(`/tickets/${encodeURIComponent(id)}/merge`, {
        confirm: true,
        force: args.flags.has("force"),
      });
      io.out(json ? JSON.stringify(body) : body.message);
      if (body.restartRequired) {
        io.err("合并完成：重启守护进程后加载新代码。");
        return EXIT.restart;
      }
      return EXIT.ok;
    }

    case "rewind": {
      const id = rest[0];
      if (!id) throw new UsageError("用法：pisa rewind <任务号> [--yes]");
      const body = await client.post<RewindResponse>(`/tickets/${encodeURIComponent(id)}/rewind`, {
        confirm: args.flags.has("yes"),
      });
      io.out(json ? JSON.stringify(body) : body.message);
      return EXIT.ok;
    }

    case "repos": {
      const repo = flagString(args, "repo");
      if (repo && !repoByAlias(cfg, repo)) throw new UsageError(`未知仓库：${repo}`);
      if (json) {
        io.out(JSON.stringify(cfg.repos));
        return EXIT.ok;
      }
      for (const r of cfg.repos) {
        io.out(
          `${r.alias}${repo && r.alias === repo ? " *" : ""} · ${r.path}${r.remote ? ` · ${r.remote}` : ""}${r.baseBranch ? ` · ${r.baseBranch}` : ""}`,
        );
      }
      return EXIT.ok;
    }

    default:
      io.out(helpText());
      return EXIT.ok;
  }
}

export function helpText(): string {
  return [
    "用法：pisa <命令> [参数] [--json] [--config 路径]",
    "",
    "命令",
    "  run <需求>                派活（--repo 指定仓库，--wait 等完成）",
    "  continue <任务号> <要求>   在原分支上续跑",
    "  wait <任务号>             等任务结束（--timeout 秒，默认 1800）",
    "  status                    守护进程、执行器与任务看板",
    "  list                      任务清单（--status、--limit、--pr、--repo）",
    "  show <任务号>             任务详情、副作用与日志尾部",
    "  logs <任务号>             原始日志（--tail 行数，默认 80）",
    "  stop <任务号>             取消任务或登记取消请求",
    "  retry <任务号>            重试中断或失败的任务",
    "  merge <任务号>            验证后合入主干（--force 跳过并发检查）",
    "  rewind <任务号>           撤销副作用（--yes 才执行，否则只预览）",
    "  repos                     仓库清单",
    "",
    "全局选项",
    "  --json                    机器可读输出",
    "  --config <路径>           配置文件（默认 PISA_CONFIG，再默认向上查找）",
    "",
    "退出码",
    "  0  正常",
    "  1  需要重启：管理接口不可达、心跳过期、合并后待重启",
    "  2  部件错误：4xx/5xx、任务失败、等待超时、用法错误",
    "  3  待配置：配置文件缺失、未授权、仓库未配置",
    "",
    "管理接口：127.0.0.1:<web.port>，token 取 PISA_WEB_TOKEN 或 <stateDir>/api.token。",
    "PISA_API_URL 可覆盖接口地址（仅回环）。",
  ].join("\n");
}

function resolveConfigPath(explicit: string | undefined): string {
  return explicit ?? process.env.PISA_CONFIG ?? findConfig(process.cwd());
}

export async function runCli(argv: string[], io: Partial<Io> = {}): Promise<number> {
  const merged: Io = { ...defaultIo, ...io };
  try {
    const args = parseArgs(argv);
    const [head = "help", ...rest] = args.positional;
    if (!(COMMANDS as readonly string[]).includes(head)) {
      if (args.flags.has("help")) {
        merged.out(helpText());
        return EXIT.ok;
      }
      throw new UsageError(`未知命令：${head}\n\n${helpText()}`);
    }
    const cmd = head as Command;
    if (cmd === "help" || args.flags.has("help")) {
      merged.out(helpText());
      return EXIT.ok;
    }
    const path = resolveConfigPath(flagString(args, "config"));
    if (!existsSync(path)) {
      merged.err(`找不到配置文件 ${path}；用 --config 指定或先运行 pisa 初始化。`);
      return EXIT.config;
    }
    const cfg = loadConfig(path);
    let base: string;
    try {
      base = apiBase(cfg);
    } catch (err) {
      merged.err(err instanceof Error ? err.message : String(err));
      return EXIT.config;
    }
    return await command(cmd, rest, args, cfg, new ApiClient(base, apiToken(cfg)), merged);
  } catch (err) {
    if (err instanceof UsageError) {
      merged.err(err.message);
      return EXIT.failed;
    }
    if (err instanceof ApiUnavailable) {
      merged.err(`${err.message}；守护进程可能没启动。`);
      return EXIT.restart;
    }
    if (err instanceof ApiError) {
      merged.err(err.message);
      return err.status === 401 || err.code === "unauthorized" || err.code === "config" ? EXIT.config : EXIT.failed;
    }
    merged.err(err instanceof Error ? err.message : String(err));
    return EXIT.failed;
  }
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
