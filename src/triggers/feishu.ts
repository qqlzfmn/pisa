import { createHash } from "node:crypto";
import type { FeishuTriggerConfig } from "../config";
import { safeEqual } from "../http";
import {
  commandText,
  TriggerError,
  type HttpTriggerRequest,
  type TriggerAdapter,
  type TriggerOutcome,
} from "./types";

/** 时间戳窗口：超出即视为重放，飞书官方建议一小时，这里取保守的 5 分钟 */
const MAX_SKEW_SEC = 300;

export interface FeishuPayload {
  body: Record<string, unknown>;
}

export interface FeishuOptions {
  config: FeishuTriggerConfig;
  /** Encrypt Key；为空时入口不可用 */
  secret: string;
  trigger: string;
  chatId: string;
  userId: string;
  repo?: string;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 飞书签名：sha256(timestamp + nonce + encryptKey + body) */
export function feishuSignature(timestamp: string, nonce: string, secret: string, body: string): string {
  return createHash("sha256").update(timestamp + nonce + secret + body).digest("hex");
}

/**
 * 飞书自建应用入口：`POST /feishu/event`。
 *
 * 只处理 `im.message.receive_v1` 的文本消息；`url_verification` 原样回 challenge。
 * 群与发送者白名单都在归一化阶段拒绝，被拒的请求不进 Router。
 */
export class FeishuAdapter implements TriggerAdapter<HttpTriggerRequest, FeishuPayload> {
  readonly name = "feishu";
  private readonly now: () => number;

  constructor(private readonly opts: FeishuOptions) {
    this.now = opts.now ?? Date.now;
  }

  async verify(req: HttpTriggerRequest): Promise<FeishuPayload> {
    if (req.method !== "POST") throw new TriggerError(405, "method not allowed");
    if (!this.opts.secret) throw new TriggerError(503, "feishu encrypt key 未配置");

    const timestamp = req.headers.get("x-lark-request-timestamp") ?? "";
    const nonce = req.headers.get("x-lark-request-nonce") ?? "";
    const signature = req.headers.get("x-lark-signature") ?? "";
    if (!timestamp || !nonce || !signature) throw new TriggerError(401, "缺少签名头");
    if (!/^\d+$/.test(timestamp)) throw new TriggerError(401, "时间戳非法");
    if (Math.abs(this.now() / 1000 - Number(timestamp)) > MAX_SKEW_SEC) {
      throw new TriggerError(401, "时间戳超出窗口");
    }
    if (!safeEqual(signature, feishuSignature(timestamp, nonce, this.opts.secret, req.body))) {
      throw new TriggerError(401, "签名校验失败");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      throw new TriggerError(400, "请求体不是合法 JSON");
    }
    const body = record(parsed);
    if (!body) throw new TriggerError(400, "请求体必须是 JSON 对象");
    return { body };
  }

  normalize(payload: FeishuPayload): TriggerOutcome | null {
    const { body } = payload;
    // 配置事件订阅地址时飞书发来的探针
    if (typeof body.challenge === "string") {
      return { reply: { body: JSON.stringify({ challenge: body.challenge }), contentType: "application/json" } };
    }

    const header = record(body.header);
    if (!header) throw new TriggerError(400, "载荷缺少 header");
    if (header.event_type !== "im.message.receive_v1") return null;

    const event = record(body.event);
    const message = record(event?.message);
    const sender = record(event?.sender);
    if (!event || !message || !sender) throw new TriggerError(400, "载荷缺少 event.message / event.sender");

    const senderId = record(sender.sender_id);
    const openId = typeof senderId?.open_id === "string" ? senderId.open_id : "";
    const chatId = typeof message.chat_id === "string" ? message.chat_id : "";
    const messageId = typeof message.message_id === "string" ? message.message_id : "";
    if (!openId || !chatId || !messageId) throw new TriggerError(400, "载荷缺少 sender_id / chat_id / message_id");

    const chats = this.opts.config.chats ?? [];
    if (chats.length > 0 && !chats.includes(chatId)) throw new TriggerError(403, `群 ${chatId} 不在白名单`);
    const users = this.opts.config.users ?? [];
    if (users.length > 0 && !users.includes(openId)) throw new TriggerError(403, `发送者 ${openId} 不在白名单`);

    // 图片、文件等非文本消息不接：没有可执行的需求正文
    if (message.message_type !== "text") return null;

    let content: unknown;
    try {
      content = JSON.parse(typeof message.content === "string" ? message.content : "");
    } catch {
      throw new TriggerError(400, "message.content 不是合法 JSON");
    }
    const raw = record(content)?.text;
    if (typeof raw !== "string") throw new TriggerError(400, "message.content 缺少 text");
    // 群聊里 @机器人 会在正文里留下 @_user_1 之类的占位
    const text = raw.replace(/@_user_\d+/g, "").replace(/@_all/g, "").trim();
    if (!text) return null;
    // mentions 是官方字段；占位符兜底兼容未带 mentions 的旧载荷
    const mentions = message.mentions;
    const mentioned = (Array.isArray(mentions) && mentions.length > 0) || /@_user_\d+|@_all/.test(raw);

    const dedupeKey = this.dedupeKey(payload);
    const chatType = typeof message.chat_type === "string" ? message.chat_type : "";
    return {
      event: {
        dedupeKey,
        message: {
          eventId: dedupeKey,
          channel: "feishu",
          chatId: this.opts.chatId,
          userId: this.opts.userId,
          actor: openId,
          mentioned,
          repo: this.opts.repo,
          isDirect: chatType === "p2p",
          text: commandText(this.opts.trigger, text),
          threadKey: `feishu:${chatId}`,
          messageKey: dedupeKey,
          version: "",
          receivedAt: this.now(),
        },
      },
    };
  }

  /** 飞书消息 id 全局唯一：同一条消息重推多少次都只建一个任务 */
  dedupeKey(payload: FeishuPayload): string {
    const message = record(record(payload.body.event)?.message);
    const id = typeof message?.message_id === "string" ? message.message_id : "";
    if (id) return `feishu:${id}`;
    const header = record(payload.body.header);
    const eventId = typeof header?.event_id === "string" ? header.event_id : "";
    return `feishu:${eventId}`;
  }
}
