import type { FeishuTriggerConfig } from "../config";
import type { IncomingMessage } from "../types";
import type { NormalizeResult, TriggerAdapter, TriggerReply, TriggerRequest, TriggerVerdict } from "./types";
import { jsonReply, textReply } from "./types";
import { obj, parseJsonObject, str, verifyFeishuSignature } from "./verify";

/** 时间戳窗口：超出视为重放 */
const MAX_SKEW_SEC = 300;
const MESSAGE_EVENT = "im.message.receive_v1";
/** 正文里的提及占位符，如 `@_user_1`；`@_all` 是 @所有人 */
const MENTION = /\s*@_(?:user_\d+|all)\s*/g;

/**
 * 飞书事件订阅（明文事件 + 签名校验）。
 * 握手先于验签：URL 校验请求不带业务事件，先验签会让平台无法完成验证。
 * 只处理文本消息；私聊直投，群消息在 @ 机器人时补触发词，其余交给 Router 判定。
 */
export class FeishuTrigger implements TriggerAdapter {
  readonly name = "feishu";
  readonly path = "feishu";

  constructor(
    private readonly cfg: FeishuTriggerConfig,
    private readonly trigger: string,
    private readonly encryptKey: string,
    private readonly verificationToken: string | undefined,
  ) {}

  handshake(req: TriggerRequest): TriggerReply | null {
    const payload = parseJsonObject(req.body);
    if (!payload) return textReply(400, "invalid json");
    if (str(payload, "type") !== "url_verification") return null;
    if (this.verificationToken && str(payload, "token") !== this.verificationToken) {
      return textReply(403, "verification token mismatch");
    }
    const challenge = str(payload, "challenge");
    if (!challenge) return textReply(400, "challenge required");
    return jsonReply(200, { challenge });
  }

  verify(req: TriggerRequest): TriggerVerdict {
    const timestamp = req.headers["x-lark-request-timestamp"];
    const seconds = Number(timestamp);
    if (!timestamp || !Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > MAX_SKEW_SEC) {
      return { ok: false, status: 403, error: "stale or missing timestamp" };
    }
    const valid = verifyFeishuSignature({
      body: req.body,
      timestamp,
      nonce: req.headers["x-lark-request-nonce"],
      encryptKey: this.encryptKey,
      signature: req.headers["x-lark-signature"],
    });
    return valid ? { ok: true } : { ok: false, status: 403, error: "signature mismatch" };
  }

  normalize(req: TriggerRequest): NormalizeResult {
    const payload = parseJsonObject(req.body);
    if (!payload) return { ok: false, status: 400, error: "invalid json" };
    if (str(payload, "header", "event_type") !== MESSAGE_EVENT) return { ok: true, events: [] };

    const messageId = str(payload, "event", "message", "message_id");
    if (!messageId) return { ok: false, status: 400, error: "missing message_id" };
    // 机器人自己的消息不接：避免回执触发下一轮
    if (str(payload, "event", "sender", "sender_type") === "app") return { ok: true, events: [] };
    if (str(payload, "event", "message", "message_type") !== "text") return { ok: true, events: [] };

    const openId = str(payload, "event", "sender", "sender_id", "open_id");
    if (!openId) return { ok: false, status: 400, error: "missing sender open_id" };
    if (this.cfg.users?.length && !this.cfg.users.includes(openId)) {
      return { ok: false, status: 403, error: "sender not allowed" };
    }

    const text = this.text(str(payload, "event", "message", "content"));
    if (text === null) return { ok: false, status: 400, error: "invalid message content" };
    const body = text.replace(MENTION, " ").trim();
    if (!body) return { ok: true, events: [] };

    const isDirect = str(payload, "event", "message", "chat_type") === "p2p";
    const needsTrigger = !isDirect && this.mentioned(payload) && this.cfg.mentionAsTrigger !== false;
    const eventId = str(payload, "header", "event_id") ?? messageId;
    const message: IncomingMessage = {
      eventId: `feishu:${eventId}`,
      channel: this.name,
      chatId: this.cfg.chatId,
      userId: this.cfg.userId,
      text: needsTrigger && !body.startsWith(this.trigger) ? `${this.trigger} ${body}` : body,
      repo: this.cfg.repo,
      isDirect,
    };
    return { ok: true, events: [{ dedupeKey: message.eventId, message }] };
  }

  /** 文本消息把正文放在 JSON 字符串里：`{"text":"..."}` */
  private text(content: string | undefined): string | null {
    if (!content) return null;
    const parsed = parseJsonObject(content);
    if (!parsed) return null;
    const value = parsed.text;
    return typeof value === "string" ? value : null;
  }

  /** 群消息里被 @：`mentions` 是非空数组 */
  private mentioned(payload: Record<string, unknown>): boolean {
    const mentions = obj(payload, "event", "message")?.mentions;
    return Array.isArray(mentions) && mentions.length > 0;
  }
}
