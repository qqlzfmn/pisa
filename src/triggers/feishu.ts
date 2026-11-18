import { createDecipheriv, createHash } from "node:crypto";
import type {
  TriggerAdapter,
  TriggerOutcome,
  TriggerPayload,
  TriggerRequest,
  TriggerVerdict,
} from "./types";
import { isRecord, jsonReply, safeEqual, text } from "./util";

export interface FeishuOptions {
  chatId: string;
  userId: string;
  repo?: string;
  /** 事件订阅的 Verification Token；与 encryptKey 至少配置一个 */
  verificationToken?: string;
  /** 事件订阅的 Encrypt Key，用于解密 encrypt 字段 */
  encryptKey?: string;
  /** 允许的 chat_id 白名单；空表示不限制 */
  chats?: string[];
  /** 允许的发送者 open_id 白名单；空表示不限制 */
  users?: string[];
  /** 群聊里未 @ 机器人时，正文需要以该触发词开头 */
  trigger: string;
}

type Decoded = { ok: true; value: Record<string, unknown> } | { ok: false; status: number; reason: string };

export class FeishuTrigger implements TriggerAdapter {
  readonly name = "feishu";

  constructor(private readonly options: FeishuOptions) {
    if (!options.verificationToken && !options.encryptKey) {
      throw new Error("feishu 需要 verificationToken 或 encryptKey");
    }
  }

  verify(req: TriggerRequest): TriggerVerdict {
    if (req.method !== "POST") return { ok: false, status: 405, reason: "只接受 POST" };
    const decoded = this.decode(req.body);
    if (!decoded.ok) return decoded;

    if (this.options.verificationToken) {
      const header = isRecord(decoded.value.header) ? decoded.value.header : {};
      const token = text(header.token) ?? text(decoded.value.token);
      if (!token) return { ok: false, status: 403, reason: "缺少 Verification Token" };
      if (!safeEqual(token, this.options.verificationToken)) {
        return { ok: false, status: 403, reason: "Verification Token 不匹配" };
      }
    }
    return { ok: true };
  }

  normalize(req: TriggerRequest): TriggerOutcome {
    const decoded = this.decode(req.body);
    if (!decoded.ok) return { kind: "reject", status: decoded.status, reason: decoded.reason };
    const value = decoded.value;

    if (value.type === "url_verification") {
      const challenge = text(value.challenge);
      if (!challenge) return { kind: "reject", status: 400, reason: "challenge 为空" };
      return { kind: "reply", reply: jsonReply(200, { challenge }) };
    }

    const header = isRecord(value.header) ? value.header : {};
    const eventType = text(header.event_type);
    if (eventType !== "im.message.receive_v1") {
      return { kind: "ignore", reason: `未订阅事件 ${eventType ?? "(缺失)"}` };
    }

    const event = isRecord(value.event) ? value.event : {};
    const sender = isRecord(event.sender) ? event.sender : {};
    const senderId = isRecord(sender.sender_id) ? sender.sender_id : {};
    const senderOpenId = text(senderId.open_id) ?? text(senderId.user_id);

    const message = isRecord(event.message) ? event.message : {};
    if (text(message.message_type) !== "text") {
      return { kind: "ignore", reason: `暂不支持消息类型 ${text(message.message_type) ?? "(缺失)"}` };
    }

    const chat = text(message.chat_id);
    if (!chat) return { kind: "reject", status: 400, reason: "消息缺少 chat_id" };
    if (this.options.chats?.length && !this.options.chats.includes(chat)) {
      return { kind: "ignore", reason: `会话 ${chat} 不在白名单` };
    }
    if (this.options.users?.length) {
      if (!senderOpenId) return { kind: "ignore", reason: "缺少发送者 open_id" };
      if (!this.options.users.includes(senderOpenId)) {
        return { kind: "ignore", reason: `发送者 ${senderOpenId} 不在白名单` };
      }
    }

    const content = parseContent(message.content);
    if (content === undefined) {
      return { kind: "reject", status: 400, reason: "消息 content 不是合法 JSON" };
    }
    const body = content.replace(/@_user_\d+/g, " ").replace(/\s+/g, " ").trim();
    if (!body) return { kind: "ignore", reason: "消息没有正文" };

    const isGroup = text(message.chat_type) !== "p2p";
    const mentioned = Array.isArray(message.mentions) && message.mentions.length > 0;
    if (isGroup && !mentioned && !body.startsWith(this.options.trigger)) {
      return { kind: "ignore", reason: "群消息未 @ 机器人" };
    }

    const externalId = text(header.event_id) ?? text(message.message_id);
    if (!externalId) return { kind: "reject", status: 400, reason: "缺少事件 id" };

    const payload: TriggerPayload = {
      externalId,
      text: body,
      chatId: this.options.chatId,
      userId: this.options.userId,
    };
    if (this.options.repo) payload.repo = this.options.repo;
    return { kind: "event", payload };
  }

  dedupeKey(payload: TriggerPayload): string {
    return `${this.name}:${payload.externalId}`;
  }

  private decode(raw: string): Decoded {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, status: 400, reason: "载荷不是合法 JSON" };
    }
    if (!isRecord(parsed)) return { ok: false, status: 400, reason: "载荷不是 JSON 对象" };

    const encrypted = text(parsed.encrypt);
    if (!encrypted) {
      // 配了 Encrypt Key 就只接受加密回调，避免明文载荷绕过加密配置
      if (this.options.encryptKey) return { ok: false, status: 400, reason: "载荷未加密" };
      return { ok: true, value: parsed };
    }
    if (!this.options.encryptKey) return { ok: false, status: 400, reason: "载荷已加密但未配置 Encrypt Key" };

    try {
      const plain = decryptFeishu(encrypted, this.options.encryptKey);
      const value: unknown = JSON.parse(plain);
      if (!isRecord(value)) return { ok: false, status: 400, reason: "解密后的载荷不是 JSON 对象" };
      return { ok: true, value };
    } catch {
      return { ok: false, status: 400, reason: "载荷解密失败" };
    }
  }
}

/** AES-256-CBC，key=SHA256(Encrypt Key)，IV 为密文前 16 字节，PKCS#7 标准补位 */
function decryptFeishu(encrypted: string, encryptKey: string): string {
  const data = Buffer.from(encrypted, "base64");
  if (data.length <= 16 || (data.length - 16) % 16 !== 0) throw new Error("invalid ciphertext");
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const decipher = createDecipheriv("aes-256-cbc", key, data.subarray(0, 16));
  const plain = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
  return plain.toString("utf8");
}

/** message.content 是 JSON 字符串；text 消息形如 {"text":"..."}，解析失败即非法载荷 */
function parseContent(content: unknown): string | undefined {
  const raw = text(content);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    return text(parsed.text) ?? "";
  } catch {
    return undefined;
  }
}
