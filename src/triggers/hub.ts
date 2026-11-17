import type { IncomingMessage } from "../types";
import type { TriggerAdapter, TriggerReply, TriggerRequest, TriggerSource } from "./types";
import { textReply } from "./types";

/** 请求体上限：事件载荷都很小，超出直接拒绝 */
const MAX_BODY = 256 * 1024;
const PREFIX = "/triggers/";

interface HttpServer {
  readonly port: number | undefined;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export interface TriggerHubOptions {
  port: number;
  host?: string;
  adapters: TriggerAdapter[];
  sources: TriggerSource[];
  deliver: (m: IncomingMessage) => void | Promise<unknown>;
}

/**
 * 事件入口的分发层：HTTP 只做方法、路径与体积检查，业务顺序是
 * 握手 → 验签 → 归一化 → 投递。`receive` 不依赖真实网络，测试直接调用。
 * 适配器的异常只影响当前请求；投递失败只告警，因为 Router 的去重键保证重投安全。
 */
export class TriggerHub {
  private server: HttpServer | null = null;

  constructor(private readonly opts: TriggerHubOptions) {}

  /** 实际监听端口：传 0 时由系统分配，测试用来走真实 HTTP 层 */
  get port(): number | undefined {
    return this.server?.port;
  }

  start(): void {
    if (this.server) return;
    const hostname = this.opts.host ?? "127.0.0.1";
    this.server = Bun.serve({
      port: this.opts.port,
      hostname,
      fetch: (req) => this.handle(req),
    });
    for (const source of this.opts.sources) source.start();
    const adapters = this.opts.adapters.map((a) => a.path).join(", ");
    console.log(`[pisa] triggers listening on ${hostname}:${this.server.port} · ${adapters || "(无 HTTP 适配器)"}`);
  }

  stop(): void {
    for (const source of this.opts.sources) source.stop();
    void this.server?.stop(true);
    this.server = null;
  }

  async receive(path: string, req: TriggerRequest): Promise<TriggerReply> {
    const adapter = this.opts.adapters.find((a) => a.path === path);
    if (!adapter) return textReply(404, "not found");
    try {
      const handshake = adapter.handshake(req);
      if (handshake) return handshake;
      const verdict = adapter.verify(req);
      if (!verdict.ok) return textReply(verdict.status, verdict.error);
      const result = adapter.normalize(req);
      if (!result.ok) return textReply(result.status, result.error);
      const accepted: string[] = [];
      for (const event of result.events) {
        try {
          await this.opts.deliver(event.message);
          accepted.push(event.dedupeKey);
        } catch (err) {
          console.warn(`[pisa] ${adapter.name} 投递失败：${(err as Error).message}`);
        }
      }
      return {
        status: 200,
        body: JSON.stringify({ ok: true, accepted }),
        contentType: "application/json",
      };
    } catch (err) {
      console.warn(`[pisa] ${adapter.name} 处理失败：${(err as Error).message}`);
      return textReply(500, "internal error");
    }
  }

  private async handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const url = new URL(req.url);
    if (!url.pathname.startsWith(PREFIX)) return new Response("not found", { status: 404 });
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY) return new Response("payload too large", { status: 413 });
    const body = await req.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY) return new Response("payload too large", { status: 413 });
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const reply = await this.receive(url.pathname.slice(PREFIX.length), { headers, body });
    return new Response(reply.body, {
      status: reply.status,
      headers: { "content-type": reply.contentType },
    });
  }
}
