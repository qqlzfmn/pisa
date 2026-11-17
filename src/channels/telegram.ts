import type { ChannelAdapter, DeliveryReceipt, IncomingMessage } from "../types";

type Handler = (m: IncomingMessage) => Promise<void> | void;

const API = "https://api.telegram.org";

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
    reply_to_message?: { message_id: number };
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 精确匹配 @用户名：`@family` 这类仓库前缀不会命中 */
export function mentionsBot(text: string, username: string): boolean {
  if (!username) return false;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?![A-Za-z0-9_])`, "i").test(text);
}

export class TelegramChannel implements ChannelAdapter {
  name = "telegram";
  private offset = 0;
  private stopped = false;
  /** getMe 得到的 bot 用户名；拿不到时保持空串，群聊按显式请求处理 */
  private botUsername = "";

  constructor(
    private token: string,
    private proxy?: string,
  ) {}

  async start(onMessage: Handler): Promise<void> {
    try {
      // 启动链在收消息之前，必须限时：代理挂住时不能拖住队列与其它入口
      const me = await this.api<{ username?: string }>("getMe", {}, 8000);
      this.botUsername = me.result?.username ?? "";
    } catch (err) {
      console.warn(`[pisa] Telegram getMe 失败，群聊按未 @ 处理：${(err as Error).message}`);
    }
    void this.poll(onMessage);
  }

  private async poll(onMessage: Handler): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const data = await this.api<TgUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ["message"],
        });
        backoff = 1000;
        for (const u of data.result ?? []) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          const m = u.message;
          if (!m?.text) continue;
          await onMessage({
            eventId: `telegram:${m.chat.id}:${m.message_id}`,
            channel: "telegram",
            chatId: String(m.chat.id),
            userId: String(m.from?.id ?? m.chat.id),
            text: m.text,
            isDirect: m.chat.type === "private",
            mentioned:
              m.chat.type === "private" || (this.botUsername !== "" && mentionsBot(m.text, this.botUsername)),
            replyToMessageId: m.reply_to_message?.message_id,
            receivedAt: (m.date ?? 0) * 1000,
          });
        }
      } catch (err) {
        if (this.stopped) break;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  async send(chatId: string, text: string): Promise<DeliveryReceipt> {
    const limit = 3800;
    let last: DeliveryReceipt = {};
    for (let i = 0; i < text.length; i += limit) {
      const res = await this.api<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text: text.slice(i, i + limit),
        disable_web_page_preview: true,
      });
      if (res.result?.message_id) last = { messageId: String(res.result.message_id) };
    }
    return last;
  }

  async setCommands(commands: ReadonlyArray<{ command: string; description: string }>): Promise<void> {
    // 同样在启动链上：代理挂住时不能拖住 Router 与其它入口
    await this.api("setMyCommands", { commands }, 8000);
  }

  private async api<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; result?: T }> {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(this.proxy ? { proxy: this.proxy } : {}),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    } as RequestInit);
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
