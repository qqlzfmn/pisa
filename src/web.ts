import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCommand, taskGuard, webConfig, type Config } from "./config";
import { ensureDir, readLogTail, type LogLine } from "./log";
import { formatDuration, type CommandOutcome, type Router } from "./router";
import type { Store } from "./store";
import type { ChannelAdapter, DeliveryReceipt, IncomingMessage, Task } from "./types";

/** 网页任务的回执只留在内存：超过这个条数丢最旧的 */
const RECEIPT_CAP = 64;
/** 运行时读取页面；无构建步骤 */
const UI_FILE = join(import.meta.dir, "ui.html");

/**
 * 包一层通道：网页任务的回执留在内存，不投递给 IM。
 * 网页任务用 `web:` 开头的 chatId，IM 消息不会撞上。
 */
export class WebChannel implements ChannelAdapter {
  readonly name: string;
  private receipts = new Map<string, string>();

  constructor(private inner?: ChannelAdapter) {
    this.name = inner?.name ?? "web";
  }

  async start(onMessage: (m: IncomingMessage) => Promise<void> | void): Promise<void> {
    await this.inner?.start(onMessage);
  }

  async send(chatId: string, text: string): Promise<DeliveryReceipt | void> {
    if (!chatId.startsWith("web:")) return this.inner?.send(chatId, text);
    // 重新插入保证 Map 顺序是最旧在前
    this.receipts.delete(chatId);
    this.receipts.set(chatId, text);
    if (this.receipts.size > RECEIPT_CAP) {
      const oldest = this.receipts.keys().next().value;
      if (oldest !== undefined) this.receipts.delete(oldest);
    }
  }

  /** 取走并清掉一条回执 */
  take(chatId: string): string | undefined {
    const text = this.receipts.get(chatId);
    this.receipts.delete(chatId);
    return text;
  }

  async stop(): Promise<void> {
    await this.inner?.stop();
  }

  async setCommands(commands: ReadonlyArray<{ command: string; description: string }>): Promise<void> {
    await this.inner?.setCommands?.(commands);
  }
}

/** token：环境变量 → stateDir/web_token → 生成并 0600 落盘 */
export function resolveWebToken(cfg: Config): string {
  const envName = webConfig(cfg).tokenEnv;
  const fromEnv = envName ? process.env[envName] : undefined;
  if (fromEnv) return fromEnv;

  const file = join(cfg.stateDir, "web_token");
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (saved) return saved;
  }
  const token = randomBytes(32).toString("hex");
  ensureDir(file);
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** API 里的任务：补上人类可读耗时，页面不再重复时间格式 */
export interface TaskView extends Task {
  duration: string;
}

function view(task: Task, now: number): TaskView {
  const started = task.startedAt;
  const duration = started === null ? "" : formatDuration((task.endedAt ?? now) - started);
  return { ...task, duration };
}

export interface WebOptions {
  cfg: Config;
  store: Store;
  router: Router;
  channel: WebChannel;
  /** 覆盖端口；测试传 0 取随机端口 */
  port?: number;
  /** 覆盖 token；缺省按 resolveWebToken 解析 */
  token?: string;
  /** 网页写操作的身份；缺省取配置 web.userId、白名单第一个用户 */
  userId?: string;
  /** 覆盖页面内容；测试用 */
  html?: string;
}

export interface WebServer {
  port: number;
  url: string;
  stop(): void;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** token 比较用定时安全比较；长度不同直接否 */
function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 三种携带方式：Authorization: Bearer、x-pisa-token、?token= */
function authorized(req: Request, url: URL, token: string): boolean {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const candidates = [bearer, req.headers.get("x-pisa-token"), url.searchParams.get("token")];
  return candidates.some((c) => typeof c === "string" && c.length > 0 && sameToken(c, token));
}

function readUi(html: string, token: string): string {
  // 注入 token；转义 < 防止提前闭合 script。用 split/join 避免 $& 之类的替换模式
  const injected = JSON.stringify(token).replace(/</g, "\\u003c");
  return html.split("__PISA_TOKEN__").join(injected);
}

/** 路径段解码：畸形百分号编码按「不存在」处理，不抛 500 */
function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

/** 起控制台：只绑本机回环地址；端口占用由调用方决定是否告警 */
export function startWebServer(opts: WebOptions): WebServer {
  const web = webConfig(opts.cfg);
  const token = opts.token ?? resolveWebToken(opts.cfg);
  const userId = opts.userId ?? web.userId ?? opts.cfg.whitelist.users[0] ?? "web";
  const html = opts.html ?? readFileSync(UI_FILE, "utf8");
  const { cfg, store, router, channel } = opts;
  // 白名单外身份派活会被 checkAccess 拒绝：启动时就说明，免得页面上只看到「任务未创建」
  if (!cfg.whitelist.users.includes(userId)) {
    console.warn(`[pisa] web 身份 ${userId} 不在 whitelist.users 里，网页派活会被拒绝；在配置里加 web.userId 或补白名单`);
  }

  const result = (out: CommandOutcome, task: Task | null): Response =>
    json(out.ok ? 200 : 409, {
      ok: out.ok,
      message: out.text,
      followUp: out.followUp ?? "",
      task: task ? view(task, Date.now()) : null,
    });

  /** 写操作的身份：受信入口，跳过「只有原请求者」 */
  const adminMsg = (): IncomingMessage => ({
    eventId: `web:${Date.now().toString(36)}:${randomBytes(4).toString("hex")}`,
    channel: "web",
    chatId: "web:api",
    userId,
    text: "",
    isDirect: true,
    admin: true,
  });

  async function dispatch(req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await req.json();
      if (!parsed || typeof parsed !== "object") return json(400, { error: "请求体必须是 JSON 对象" });
      body = parsed as Record<string, unknown>;
    } catch {
      return json(400, { error: "请求体不是 JSON" });
    }

    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const repo = typeof body.repo === "string" ? body.repo.trim() : "";
    if (!prompt) return json(400, { error: "需求不能为空。" });
    if (repo && !cfg.repos.some((r) => r.alias === repo)) return json(400, { error: `未知仓库：${repo}` });

    const text = `${cfg.trigger} ${prompt}`;
    if (parseCommand(text, cfg.trigger)?.kind !== "task") {
      return json(400, { error: "需求不能以命令词开头。" });
    }
    const guard = taskGuard(prompt);
    if (guard) {
      return json(400, {
        error:
          guard.kind === "suggest"
            ? `「${prompt}」像是一个命令；要派活请写成完整需求。`
            : `「${prompt}」只有一个英文单词，请把需求写完整。`,
      });
    }

    const eventId = `web:${Date.now().toString(36)}:${randomBytes(4).toString("hex")}`;
    const msg: IncomingMessage = {
      ...adminMsg(),
      eventId,
      chatId: `web:${eventId}`,
      text,
      receivedAt: Date.now(),
    };
    if (repo) msg.repo = repo;

    await router.handle(msg);
    const message = channel.take(msg.chatId) ?? "";
    const task = store.taskBySource(eventId);
    if (!task) return json(400, { error: message || "任务未创建。" });
    return json(201, { ok: true, task: view(task, Date.now()), message });
  }

  async function act(id: string, kind: "cancel" | "merge"): Promise<Response> {
    const task = store.get(id);
    if (!task) return json(404, { error: `找不到任务 ${id}` });
    const out = kind === "cancel" ? router.cancelTask(adminMsg(), id) : router.mergeTask(adminMsg(), id);
    return result(out, store.get(id) ?? task);
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!authorized(req, url, token)) return json(401, { error: "未授权：缺少或错误的 token" });

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
      return new Response(readUi(html, token), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    const seg = url.pathname.split("/").filter(Boolean);
    if (seg[0] !== "api" || seg[1] !== "tasks") return json(404, { error: "not found" });

    if (seg.length === 2) {
      if (req.method === "GET") {
        const repo = url.searchParams.get("repo") || undefined;
        const now = Date.now();
        return json(200, {
          now,
          counts: store.countByStatus(repo),
          repos: cfg.repos.map((r) => r.alias),
          running: store.runningTasks(repo).map((t) => view(t, now)),
          queued: store.queuedTasks(repo).map((t) => view(t, now)),
          finished: store.recentFinished(20, repo).map((t) => view(t, now)),
        });
      }
      if (req.method === "POST") return dispatch(req);
      return json(405, { error: "method not allowed" });
    }

    const id = seg[2] ? safeDecode(seg[2]) : "";
    if (seg.length === 3) {
      if (req.method !== "GET") return json(405, { error: "method not allowed" });
      const task = store.get(id);
      if (!task) return json(404, { error: `找不到任务 ${id}` });
      const log: LogLine[] = readLogTail(cfg.stateDir, id);
      return json(200, { task: view(task, Date.now()), log });
    }

    const action = seg[3];
    if (seg.length === 4 && req.method === "POST" && (action === "cancel" || action === "merge")) {
      return act(id, action);
    }
    return json(404, { error: "not found" });
  }

  const server = Bun.serve({
    port: opts.port ?? web.port,
    hostname: "127.0.0.1",
    fetch: (req) => route(req),
  });

  return {
    port: server.port ?? (opts.port ?? web.port),
    url: `http://127.0.0.1:${server.port}/ui?token=${encodeURIComponent(token)}`,
    stop: () => void server.stop(true),
  };
}
