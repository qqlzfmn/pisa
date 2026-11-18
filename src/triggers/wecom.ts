import { createDecipheriv, createHash } from "node:crypto";
import { BaseTriggerAdapter, equalHex, nonEmptyString, type TriggerOutcome, type TriggerRequest } from "./types";

export interface WecomOptions {
  /** 接收消息服务器配置里的 Token */
  token: string;
  /** 接收消息服务器配置里的 EncodingAESKey（43 字符） */
  aesKey: string;
  /** 企业 ID：解密后校验 corpid，防止跨企业投递 */
  corpId: string;
  /** 允许的成员 UserID 白名单；空数组即全部忽略 */
  users: string[];
  /** 任务归属仓库 alias；缺省时 Router 用默认仓库 */
  repo?: string;
}

/** 企业微信回调：GET 是 URL 校验握手，POST 是加密的 XML 消息 */
export class WecomAdapter extends BaseTriggerAdapter {
  readonly name = "wecom";
  private readonly options: WecomOptions;

  constructor(options: WecomOptions) {
    super();
    this.options = options;
  }

  verify(req: TriggerRequest): string | null {
    const signature = req.query.get("msg_signature");
    const timestamp = req.query.get("timestamp");
    const nonce = req.query.get("nonce");
    if (!signature || !timestamp || !nonce) return "缺少 msg_signature / timestamp / nonce";
    const encrypted =
      req.method === "GET" ? nonEmptyString(req.query.get("echostr")) : xmlField(req.body, "Encrypt");
    if (!encrypted) return req.method === "GET" ? "缺少 echostr" : "载荷缺少 Encrypt";
    const expected = createHash("sha1")
      .update([this.options.token, timestamp, nonce, encrypted].sort().join(""))
      .digest("hex");
    return equalHex(expected, signature) ? null : "签名不匹配";
  }

  normalize(req: TriggerRequest): TriggerOutcome {
    const encrypted = req.method === "GET" ? nonEmptyString(req.query.get("echostr")) : xmlField(req.body, "Encrypt");
    if (!encrypted) return { kind: "reject", status: 400, reason: "载荷缺少 Encrypt" };
    let xml: string;
    try {
      xml = decrypt(encrypted, this.options.aesKey, this.options.corpId);
    } catch (err) {
      return { kind: "reject", status: 400, reason: `解密失败：${(err as Error).message}` };
    }
    // 握手：平台要原样收到 echostr 的明文
    if (req.method === "GET") return { kind: "challenge", body: xml };

    const msgType = xmlField(xml, "MsgType");
    if (!msgType) return { kind: "reject", status: 400, reason: "消息缺少 MsgType" };
    if (msgType !== "text") return { kind: "ignore", reason: `消息类型 ${msgType} 不处理` };
    const from = xmlField(xml, "FromUserName");
    const messageId = xmlField(xml, "MsgId");
    if (!from || !messageId) return { kind: "reject", status: 400, reason: "消息缺少 FromUserName / MsgId" };
    const text = (xmlField(xml, "Content") ?? "").trim();
    if (!text) return { kind: "ignore", reason: "消息不含正文" };
    if (!this.options.users.includes(from)) return { kind: "ignore", reason: `用户 ${from} 不在白名单` };
    const created = Number(xmlField(xml, "CreateTime"));
    return {
      kind: "event",
      repo: this.options.repo,
      event: {
        threadKey: `wecom:${from}`,
        messageKey: messageId,
        version: "",
        actor: from,
        text,
        at: Number.isFinite(created) ? created * 1000 : Date.now(),
      },
    };
  }
}

function xmlField(xml: string, name: string): string | null {
  const matched = new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${name}>`).exec(xml);
  if (!matched) return null;
  const value = matched[1] ?? matched[2] ?? "";
  return value.length > 0 ? value : null;
}

/**
 * 企业微信 AES-256-CBC：key = base64(EncodingAESKey + "=")，IV 取 key 前 16 字节。
 * 明文结构 = 16 字节随机 + 4 字节大端消息长度 + 消息 + corpid，PKCS#7 按 32 字节补位，
 * Node 的自动去填充只认 16 字节块，所以关掉自动填充手动剥。
 */
function decrypt(encrypted: string, aesKey: string, corpId: string): string {
  const key = Buffer.from(`${aesKey}=`, "base64");
  if (key.length !== 32) throw new Error("EncodingAESKey 非法");
  const data = Buffer.from(encrypted, "base64");
  if (data.length === 0 || data.length % 16 !== 0) throw new Error("密文长度非法");
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  const pad = plain[plain.length - 1] ?? 0;
  if (pad < 1 || pad > 32) throw new Error("填充非法");
  if (!plain.subarray(plain.length - pad).every((byte) => byte === pad)) throw new Error("填充非法");
  const body = plain.subarray(0, plain.length - pad);
  if (body.length < 20) throw new Error("明文长度非法");
  const length = body.readUInt32BE(16);
  if (20 + length > body.length) throw new Error("消息长度非法");
  const message = body.subarray(20, 20 + length).toString("utf8");
  const appId = body.subarray(20 + length).toString("utf8");
  if (appId !== corpId) throw new Error("corpid 不匹配");
  return message;
}
