import { createDecipheriv, createHash } from "node:crypto";
import type {
  TriggerAdapter,
  TriggerOutcome,
  TriggerPayload,
  TriggerRequest,
  TriggerVerdict,
} from "./types";
import { safeEqual, text } from "./util";

export interface WecomOptions {
  chatId: string;
  userId: string;
  repo?: string;
  /** 应用「接收消息」里配置的 Token */
  token: string;
  /** 应用「接收消息」里配置的 EncodingAESKey（43 位） */
  aesKey: string;
  /** 企业 ID；解密结果里的 receiveid 必须与它一致 */
  corpId: string;
  /** 允许的发送者 UserID 白名单；空表示不限制 */
  users?: string[];
}

export class WecomTrigger implements TriggerAdapter {
  readonly name = "wecom";
  private readonly aesKey: Buffer;

  constructor(private readonly options: WecomOptions) {
    const key = Buffer.from(normalizeAesKey(options.aesKey), "base64");
    if (key.length !== 32) throw new Error("wecom.aesKeyEnv 不是合法的 32 字节 EncodingAESKey");
    if (options.token.trim() === "") throw new Error("wecom.tokenEnv 对应的环境变量为空");
    if (options.corpId.trim() === "") throw new Error("wecom.corpId 不能为空");
    this.aesKey = key;
  }

  verify(req: TriggerRequest): TriggerVerdict {
    const method = req.method.toUpperCase();
    if (method === "GET") {
      const params = req.url.searchParams;
      const signature = params.get("msg_signature");
      const timestamp = params.get("timestamp");
      const nonce = params.get("nonce");
      const echo = params.get("echostr");
      if (!signature) return { ok: false, status: 401, reason: "缺少 msg_signature" };
      if (!timestamp || !nonce) return { ok: false, status: 400, reason: "缺少 timestamp 或 nonce" };
      if (!echo) return { ok: false, status: 400, reason: "缺少 echostr" };
      return this.checkSignature(signature, timestamp, nonce, echo);
    }
    if (method !== "POST") return { ok: false, status: 405, reason: "只接受 GET 与 POST" };

    const params = req.url.searchParams;
    const signature = params.get("msg_signature");
    const timestamp = params.get("timestamp");
    const nonce = params.get("nonce");
    if (!signature) return { ok: false, status: 401, reason: "缺少 msg_signature" };
    if (!timestamp || !nonce) return { ok: false, status: 400, reason: "缺少 timestamp 或 nonce" };
    const encrypt = xmlTag(req.body, "Encrypt");
    if (!encrypt) return { ok: false, status: 400, reason: "载荷缺少 Encrypt" };
    return this.checkSignature(signature, timestamp, nonce, encrypt);
  }

  normalize(req: TriggerRequest): TriggerOutcome {
    const method = req.method.toUpperCase();
    if (method === "GET") {
      const echo = req.url.searchParams.get("echostr");
      if (!echo) return { kind: "reject", status: 400, reason: "缺少 echostr" };
      try {
        return { kind: "reply", reply: { status: 200, body: this.decrypt(echo).msg } };
      } catch {
        return { kind: "reject", status: 400, reason: "echostr 解密失败" };
      }
    }
    if (method !== "POST") return { kind: "reject", status: 405, reason: "只接受 GET 与 POST" };

    const encrypt = xmlTag(req.body, "Encrypt");
    if (!encrypt) return { kind: "reject", status: 400, reason: "载荷缺少 Encrypt" };

    let decrypted: { msg: string; receiveId: string };
    try {
      decrypted = this.decrypt(encrypt);
    } catch {
      return { kind: "reject", status: 400, reason: "消息解密失败" };
    }
    if (decrypted.receiveId !== this.options.corpId) {
      return { kind: "reject", status: 403, reason: "receiveid 与企业 ID 不匹配" };
    }

    if (xmlTag(decrypted.msg, "MsgType") !== "text") {
      return { kind: "ignore", reason: `暂不支持消息类型 ${xmlTag(decrypted.msg, "MsgType") ?? "(缺失)"}` };
    }
    const sender = xmlTag(decrypted.msg, "FromUserName");
    if (this.options.users?.length) {
      if (!sender) return { kind: "ignore", reason: "缺少发送者 UserID" };
      if (!this.options.users.includes(sender)) {
        return { kind: "ignore", reason: `发送者 ${sender} 不在白名单` };
      }
    }

    const body = (xmlTag(decrypted.msg, "Content") ?? "").replace(/\s+/g, " ").trim();
    if (!body) return { kind: "ignore", reason: "消息没有正文" };

    const externalId =
      xmlTag(decrypted.msg, "MsgId") ??
      createHash("sha256").update(decrypted.msg, "utf8").digest("hex");
    const payload: TriggerPayload = {
      externalId,
      text: body,
      chatId: this.options.chatId,
      userId: this.options.userId,
    };
    if (this.options.repo) payload.repo = this.options.repo;
    return {
      kind: "event",
      payload,
      ack: { status: 200, body: "success" },
    };
  }

  dedupeKey(payload: TriggerPayload): string {
    return `${this.name}:${payload.externalId}`;
  }

  private checkSignature(signature: string, timestamp: string, nonce: string, payload: string): TriggerVerdict {
    const expected = createHash("sha1")
      .update([this.options.token, timestamp, nonce, payload].sort().join(""), "utf8")
      .digest("hex");
    if (!safeEqual(signature.toLowerCase(), expected)) {
      return { ok: false, status: 401, reason: "签名不匹配" };
    }
    return { ok: true };
  }

  private decrypt(encrypted: string): { msg: string; receiveId: string } {
    const data = Buffer.from(encrypted, "base64");
    if (data.length === 0 || data.length % 16 !== 0) throw new Error("invalid ciphertext");

    const decipher = createDecipheriv("aes-256-cbc", this.aesKey, this.aesKey.subarray(0, 16));
    // 企业微信补位以 32 字节为块，不能交给 OpenSSL 的 16 字节默认值
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);

    const pad = plain[plain.length - 1];
    if (pad === undefined || pad < 1 || pad > 32 || pad > plain.length) throw new Error("invalid padding");
    const payload = plain.subarray(0, plain.length - pad);
    if (payload.length < 20) throw new Error("truncated payload");

    const length = payload.readUInt32BE(16);
    if (20 + length > payload.length) throw new Error("invalid message length");
    return {
      msg: payload.subarray(20, 20 + length).toString("utf8"),
      receiveId: payload.subarray(20 + length).toString("utf8"),
    };
  }
}

function normalizeAesKey(value: string): string {
  return value.endsWith("=") ? value : `${value}=`;
}

/** 企业微信消息是扁平 XML；只取需要的标签，兼容 CDATA */
function xmlTag(xml: string, name: string): string | undefined {
  const match = new RegExp(
    `<${name}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${name}>`,
  ).exec(xml);
  const raw = match?.[1] ?? match?.[2];
  return raw === undefined ? undefined : text(unescapeXml(raw));
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
