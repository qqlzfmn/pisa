import { createDecipheriv, createHash } from "node:crypto";
import {
  BaseTriggerAdapter,
  equalHex,
  nonEmptyString,
  parseJsonObject,
  type TriggerOutcome,
  type TriggerRequest,
} from "./types";

export interface FeishuOptions {
  /** 事件订阅的 Encrypt Key：既算签名，也当解密密钥 */
  encryptKey: string;
  /** 允许的群 chat_id 白名单；空数组即全部忽略 */
  chats: string[];
  /** 允许的发送者 open_id 白名单；缺省不限 */
  users?: string[];
  /** 任务归属仓库 alias；缺省时 Router 用默认仓库 */
  repo?: string;
}

interface FeishuEnvelope {
  type?: unknown;
  challenge?: unknown;
  encrypt?: unknown;
  header?: { event_type?: unknown };
  event?: {
    sender?: { sender_id?: { open_id?: unknown } };
    message?: {
      message_id?: unknown;
      chat_id?: unknown;
      message_type?: unknown;
      content?: unknown;
      create_time?: unknown;
    };
  };
}

/** 签名允许的时钟偏差：超出窗口的请求即便签名正确也拒收（防重放） */
const TIMESTAMP_WINDOW_SEC = 300;

/** 飞书事件订阅：签名 + 可选 AES 解密，文本消息转任务 */
export class FeishuAdapter extends BaseTriggerAdapter {
  readonly name = "feishu";
  private readonly options: FeishuOptions;
  private readonly now: () => number;

  constructor(options: FeishuOptions, now: () => number = Date.now) {
    super();
    this.options = options;
    this.now = now;
  }

  verify(req: TriggerRequest): string | null {
    const timestamp = req.headers.get("x-lark-request-timestamp");
    const nonce = req.headers.get("x-lark-request-nonce");
    const signature = req.headers.get("x-lark-signature");
    if (!timestamp || !nonce || !signature) return "缺少飞书签名头";
    if (!/^\d+$/.test(timestamp)) return "请求时间戳非法";
    if (Math.abs(Math.floor(this.now() / 1000) - Number(timestamp)) > TIMESTAMP_WINDOW_SEC) {
      return "请求时间戳超出允许窗口";
    }
    const expected = createHash("sha256").update(timestamp + nonce + this.options.encryptKey + req.body).digest("hex");
    return equalHex(expected, signature) ? null : "签名不匹配";
  }

  normalize(req: TriggerRequest): TriggerOutcome {
    const raw = parseJsonObject(req.body);
    if (!raw) return { kind: "reject", status: 400, reason: "载荷不是 JSON 对象" };
    let payload = raw as FeishuEnvelope;
    const encrypted = nonEmptyString(raw.encrypt);
    if (encrypted) {
      let plain: string;
      try {
        plain = decrypt(encrypted, this.options.encryptKey);
      } catch {
        return { kind: "reject", status: 400, reason: "载荷解密失败" };
      }
      const inner = parseJsonObject(plain);
      if (!inner) return { kind: "reject", status: 400, reason: "解密后的载荷不是 JSON 对象" };
      payload = inner as FeishuEnvelope;
    }

    if (payload.type === "url_verification") {
      const challenge = nonEmptyString(payload.challenge);
      if (!challenge) return { kind: "reject", status: 400, reason: "握手缺少 challenge" };
      return { kind: "challenge", body: JSON.stringify({ challenge }), contentType: "application/json" };
    }

    const eventType = nonEmptyString(payload.header?.event_type);
    if (eventType !== "im.message.receive_v1") {
      return { kind: "ignore", reason: `事件 ${eventType ?? "(空)"} 不处理` };
    }
    const message = payload.event?.message;
    if (!message) return { kind: "reject", status: 400, reason: "载荷缺少 event.message" };
    const messageId = nonEmptyString(message.message_id);
    const chatId = nonEmptyString(message.chat_id);
    if (!messageId || !chatId) return { kind: "reject", status: 400, reason: "载荷缺少 message_id / chat_id" };
    const messageType = nonEmptyString(message.message_type);
    if (messageType !== "text") return { kind: "ignore", reason: `消息类型 ${messageType ?? "(空)"} 不处理` };
    const content = typeof message.content === "string" ? parseJsonObject(message.content) : null;
    const text = stripMentions(nonEmptyString(content?.text) ?? "");
    if (!text) return { kind: "ignore", reason: "消息不含正文" };
    if (!this.options.chats.includes(chatId)) return { kind: "ignore", reason: `群 ${chatId} 不在白名单` };
    const actor = nonEmptyString(payload.event?.sender?.sender_id?.open_id) ?? "";
    if (this.options.users?.length && !this.options.users.includes(actor)) {
      return { kind: "ignore", reason: `发送者 ${actor} 不在白名单` };
    }
    const created = typeof message.create_time === "string" ? Number(message.create_time) : Number.NaN;
    return {
      kind: "event",
      repo: this.options.repo,
      event: {
        threadKey: `feishu:${chatId}`,
        messageKey: messageId,
        version: "",
        actor: actor || "feishu",
        text,
        at: Number.isFinite(created) ? created : this.now(),
      },
    };
  }
}

/** 去掉 @ 占位符：飞书把被 @ 的人替换成 `@_user_N`，@所有人是 `@_all` */
function stripMentions(text: string): string {
  return text
    .replace(/@_user_\d+/g, " ")
    .replace(/@_all/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 飞书 AES-256-CBC：密钥取 Encrypt Key 的 sha256 摘要，密文前 16 字节是 IV */
function decrypt(encrypted: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const data = Buffer.from(encrypted, "base64");
  if (data.length <= 16 || data.length % 16 !== 0) throw new Error("密文长度非法");
  const decipher = createDecipheriv("aes-256-cbc", key, data.subarray(0, 16));
  return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString("utf8");
}
