import type { ChannelAdapter, DeliveryReceipt, IncomingMessage } from "../types";

type Handler = (m: IncomingMessage) => Promise<void> | void;

const API = "https://api.telegram.org";

interface TgMessage {
  message_id: number;
  date: number;
  text?: string;
  chat: { id: number; type: string };
  from?: { id: number; username?: string };
  reply_to_message?: { message_id: number };
  /** 论坛话题的话题 id：同一话题的消息归为一条线程 */
  message_thread_id?: number;
  /** 编辑时间（秒）：有它说明是 edited_message，按版本区分 */
  edit_date?: number;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class TelegramChannel implements ChannelAdapter {
  name = "telegram";
  private offset = 0;
  private stopped = false;
  /** 429 后静默到这个时间点 */
  private sendAfter = 0;

  constructor(
    private token: string,
    private proxy?: string,
  ) {}

  async start(onMessage: Handler): Promise<void> {
    void this.poll(onMessage);
  }

  private async poll(onMessage: Handler): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const data = await this.api<TgUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ["message", "edited_message"],
        });
        backoff = 1000;
        for (const u of data.result ?? []) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          const m = u.message ?? u.edited_message;
          if (!m?.text) continue;
          await onMessage({
            eventId: `telegram:${m.chat.id}:${m.message_id}`,
            channel: "telegram",
            chatId: String(m.chat.id),
            userId: String(m.from?.id ?? m.chat.id),
            text: m.text,
            isDirect: m.chat.type === "private",
            replyToMessageId: m.reply_to_message?.message_id,
            receivedAt: (m.edit_date ?? m.date ?? 0) * 1000,
            threadKey: m.message_thread_id ? `telegram:${m.chat.id}:topic:${m.message_thread_id}` : undefined,
            messageKey: String(m.message_id),
            version: String(m.edit_date ?? m.date ?? ""),
            actor: String(m.from?.username ?? m.from?.id ?? m.chat.id),
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
    // 被 Telegram 限流时静默跳过，避免把 429 传染给调用方
    if (Date.now() < this.sendAfter) return {};
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
    await this.api("setMyCommands", { commands });
  }

  private async api<T = unknown>(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: T }> {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(this.proxy ? { proxy: this.proxy } : {}),
    } as RequestInit);
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    if (!json.ok) {
      const retry = json.parameters?.retry_after;
      if (typeof retry === "number") this.sendAfter = Date.now() + retry * 1000;
      throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    }
    return json;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
