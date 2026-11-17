import { formatBoard, type StateSnapshot } from "./board";
import { loadConfig, mgmtSettings } from "./config";
import type { LogEntry } from "./log";

/** 退出码：脚本按这几档分支，不再解析文本 */
export const EXIT = { OK: 0, RESTART: 1, ERROR: 2, CONFIG: 3 } as const;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CliDeps {
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  now?: () => number;
  /** 目标地址与 token；默认读配置与环境变量，测试覆盖 */
  target?: () => { url: string; token: string | undefined };
}

interface Target {
  url: string;
  token: string;
}

/** 管理接口的响应形状；同源实现见 src/mgmt.ts */
interface TicketPayload {
  ticket: { id: string; repo: string };
}
interface LogsPayload {
  entries: LogEntry[];
}
interface TextPayload {
  ok: boolean;
  text: string;
  needsRestart?: boolean;
}

const USAGE = [
  "pisa <命令> [参数] [--json]",
  "",
  "  status                 查看执行器与任务状态",
  "  run <需求> [--repo 别名]  提交任务",
  "  logs <任务号>           查看任务日志",
  "  merge <任务号>          验证并合并任务分支（合并成功需重启时退出码 1）",
  "  rewind <任务号> [--yes] 预览或执行副作用撤销",
  "",
  "退出码：0 正常 / 1 需重启 / 2 部件错误 / 3 待配置",
].join("\n");

function parseFlags(argv: string[]): { args: string[]; json: boolean; yes: boolean } {
  const args: string[] = [];
  let json = false;
  let yes = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--yes") yes = true;
    else args.push(a);
  }
  return { args, json, yes };
}

function takeOption(args: string[], name: string): { rest: string[]; value?: string } {
  const i = args.indexOf(name);
  if (i < 0) return { rest: args };
  const value = args[i + 1];
  return { rest: [...args.slice(0, i), ...args.slice(i + 2)], value };
}

function reasonOf(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    return typeof body.error === "string" ? body.error : "未知错误";
  }
  return "未知错误";
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => console.log(text));
  const writeErr = deps.stderr ?? ((text: string) => console.error(text));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const fail = (message: string): number => {
    writeErr(message);
    return EXIT.ERROR;
  };
  const failFor = (res: { status: number; body: unknown }): number => {
    if (res.status === 401 || res.status === 403) {
      writeErr(reasonOf(res.body));
      return EXIT.CONFIG;
    }
    return fail(reasonOf(res.body));
  };

  const { args, json, yes } = parseFlags(argv);
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help") {
    out(USAGE);
    return command ? EXIT.OK : EXIT.ERROR;
  }

  const resolve =
    deps.target ??
    (() => {
      const settings = mgmtSettings(loadConfig());
      return { url: env.PISA_MGMT_URL ?? `http://127.0.0.1:${settings.port}`, token: env[settings.tokenEnv] };
    });

  let target: Target;
  try {
    const resolved = resolve();
    if (!resolved.token) {
      writeErr("未配置管理接口 token：启动 pisa 时设置 PISA_MGMT_TOKEN，CLI 用同名环境变量读取。");
      return EXIT.CONFIG;
    }
    target = { url: resolved.url.replace(/\/+$/, ""), token: resolved.token };
  } catch (e) {
    writeErr(`读取配置失败：${e instanceof Error ? e.message : String(e)}`);
    return EXIT.CONFIG;
  }

  const call = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown } | null> => {
    try {
      const res = await fetchImpl(`${target.url}${path}`, {
        ...init,
        headers: { "x-pisa-token": target.token, "content-type": "application/json" },
      });
      const body = (await res.json().catch(() => null)) as unknown;
      return { status: res.status, body };
    } catch {
      return null;
    }
  };

  const post = (path: string, payload: unknown) => call(path, { method: "POST", body: JSON.stringify(payload) });

  switch (command) {
    case "status": {
      const res = await call("/state");
      if (!res) return fail("无法连接管理接口。");
      if (res.status !== 200) return failFor(res);
      if (json) out(JSON.stringify(res.body));
      else {
        // 回环同源接口，形状由 src/mgmt.ts 保证
        const state = res.body as StateSnapshot;
        out(formatBoard(state, now()));
      }
      return EXIT.OK;
    }

    case "run": {
      const { rest: positional, value: repo } = takeOption(rest, "--repo");
      const prompt = positional.join(" ").trim();
      if (!prompt) return fail("用法：pisa run <需求> [--repo 别名]");
      const res = await post("/tickets", { prompt, repo });
      if (!res) return fail("无法连接管理接口。");
      if (res.status !== 201) return failFor(res);
      const payload = res.body as TicketPayload;
      if (json) out(JSON.stringify(payload.ticket));
      else out(`已接单 · ${payload.ticket.id}\n仓库：${payload.ticket.repo}\n排队中。`);
      return EXIT.OK;
    }

    case "logs": {
      const id = rest[0];
      if (!id) return fail("用法：pisa logs <任务号>");
      const res = await call(`/tickets/${encodeURIComponent(id)}/logs`);
      if (!res) return fail("无法连接管理接口。");
      if (res.status !== 200) return failFor(res);
      const payload = res.body as LogsPayload;
      if (json) out(JSON.stringify(payload.entries));
      else if (payload.entries.length === 0) out("(无日志)");
      else out(payload.entries.map((e) => `${e.ts} ${e.stage} ${e.msg}`).join("\n"));
      return EXIT.OK;
    }

    case "merge": {
      const id = rest[0];
      if (!id) return fail("用法：pisa merge <任务号>");
      const res = await post(`/tickets/${encodeURIComponent(id)}/merge`, {});
      if (!res) return fail("无法连接管理接口。");
      if (res.status !== 200) return failFor(res);
      const payload = res.body as TextPayload;
      if (json) out(JSON.stringify(payload));
      else out(payload.text);
      return payload.needsRestart ? EXIT.RESTART : EXIT.OK;
    }

    case "rewind": {
      const id = rest[0];
      if (!id) return fail("用法：pisa rewind <任务号> [--yes]");
      const res = await post(`/tickets/${encodeURIComponent(id)}/rewind`, { yes });
      if (!res) return fail("无法连接管理接口。");
      if (res.status !== 200) return failFor(res);
      const payload = res.body as TextPayload;
      if (json) out(JSON.stringify(payload));
      else out(payload.text);
      return EXIT.OK;
    }

    default:
      return fail(`未知命令：${command}\n\n${USAGE}`);
  }
}
