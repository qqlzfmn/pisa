import { createDecipheriv, createHash } from "node:crypto";
import type { WecomTriggerConfig } from "../config";
import { safeEqual } from "../http";
import {
  commandText,
  TriggerError,
  type HttpTriggerRequest,
  type TriggerAdapter,
  type TriggerOutcome,
} from "./types";

export interface WecomPayload {
  /** 解密后的消息 XML */
  xml: string;
  fields: Record<string, string>;
  /** GET 校验时解密出来的 echostr，需要原样回给企业微信 */
  echo?: string;
}

export interface WecomOptions {
  config: WecomTriggerConfig;
  token: string;
  aesKey: string;
  trigger: string;
  chatId: string;
  userId: string;
  repo?: string;
  now?: () => number;
}

/** 企业微信签名：token、timestamp、nonce、密文四者字典序拼接后 sha1 */
export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join("")).digest("hex");
}

/** 取一个 XML 标签的文本，兼容 CDATA 与裸文本 */
function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${name}>`).exec(xml);
  return (m?.[1] ?? m?.[2] ?? "").trim();
}

/**
 * AES-256-CBC 解密（WXBizMsgCrypt 格式）：
 * 16 字节随机数 + 4 字节网络序长度 + 正文 + 到 32 字节块的补位。
 */
function decrypt(aesKey: string, encrypt: string): string {
  const key = Buffer.from(`${aesKey}=`, "base64");
  if (key.length !== 32) throw new TriggerError(401, "EncodingAESKey 非法");
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    plain = Buffer.concat([decipher.update(Buffer.from(encrypt, "base64")), decipher.final()]);
  } catch {
    throw new TriggerError(401, "密文解密失败");
  }
  const pad = plain[plain.length - 1] ?? 0;
  if (plain.length < 21 || pad < 1 || pad > 32) throw new TriggerError(401, "密文填充非法");
  const body = plain.subarray(0, plain.length - pad);
  const length = body.readUInt32BE(16);
  if (body.length < 20 + length) throw new TriggerError(401, "密文长度非法");
  return body.subarray(20, 20 + length).toString("utf8");
}

/**
 * 企业微信应用回调：`GET|POST /wecom/event`。
 *
 * GET 是配置回调地址时的校验（回解密后的 echostr）；POST 是消息推送，
 * 正文本身就是签名与解密的对象，明文 XML 交给归一化。企业微信要求回 `success`。
 */
export class WecomAdapter implements TriggerAdapter<HttpTriggerRequest, WecomPayload> {
  readonly name = "wecom";
  private readonly now: () => number;

  constructor(private readonly opts: WecomOptions) {
    this.now = opts.now ?? Date.now;
  }

  async verify(req: HttpTriggerRequest): Promise<WecomPayload> {
    if (req.method !== "GET" && req.method !== "POST") throw new TriggerError(405, "method not allowed");
    if (!this.opts.token || !this.opts.aesKey) throw new TriggerError(503, "wecom token / aes key 未配置");

    const query = new URL(req.url).searchParams;
    const timestamp = query.get("timestamp") ?? "";
    const nonce = query.get("nonce") ?? "";
    const signature = query.get("msg_signature") ?? "";
    if (!timestamp || !nonce || !signature) throw new TriggerError(401, "缺少签名参数");

    if (req.method === "GET") {
      const echo = query.get("echostr") ?? "";
      if (!echo) throw new TriggerError(400, "缺少 echostr");
      if (!safeEqual(signature, wecomSignature(this.opts.token, timestamp, nonce, echo))) {
        throw new TriggerError(401, "签名校验失败");
      }
      return { xml: "", fields: {}, echo: decrypt(this.opts.aesKey, echo) };
    }

    const encrypt = tag(req.body, "Encrypt");
    if (!encrypt) throw new TriggerError(400, "请求体缺少 Encrypt");
    if (!safeEqual(signature, wecomSignature(this.opts.token, timestamp, nonce, encrypt))) {
      throw new TriggerError(401, "签名校验失败");
    }
    const xml = decrypt(this.opts.aesKey, encrypt);
    const fields: Record<string, string> = {};
    for (const name of ["ToUserName", "FromUserName", "CreateTime", "MsgType", "Content", "MsgId", "AgentID", "Event"]) {
      const value = tag(xml, name);
      if (value) fields[name] = value;
    }
    return { xml, fields };
  }

  normalize(payload: WecomPayload): TriggerOutcome | null {
    // 校验请求只回显，不建任务
    if (payload.echo !== undefined) {
      return { reply: { body: payload.echo, contentType: "text/plain; charset=utf-8" } };
    }
    const success: TriggerOutcome = { reply: { body: "success", contentType: "text/plain; charset=utf-8" } };

    const { fields } = payload;
    const from = fields.FromUserName ?? "";
    if (!from) throw new TriggerError(400, "消息缺少 FromUserName");

    const users = this.opts.config.users ?? [];
    if (users.length > 0 && !users.includes(from)) throw new TriggerError(403, `发送者 ${from} 不在白名单`);

    // 非文本（事件、图片）只回 success，不建任务
    if (fields.MsgType !== "text") return success;
    const text = (fields.Content ?? "").trim();
    if (!text) return success;

    const dedupeKey = this.dedupeKey(payload);
    return {
      ...success,
      event: {
        dedupeKey,
        message: {
          eventId: dedupeKey,
          channel: "wecom",
          chatId: this.opts.chatId,
          userId: this.opts.userId,
          actor: from,
          repo: this.opts.repo,
          isDirect: true,
          text: commandText(this.opts.trigger, text),
          threadKey: `wecom:${from}`,
          messageKey: dedupeKey,
          version: "",
          receivedAt: this.now(),
        },
      },
    };
  }

  /** MsgId 是企业微信给的消息 id；事件类消息没有 MsgId，用发送者 + 时间兜底 */
  dedupeKey(payload: WecomPayload): string {
    const { fields } = payload;
    if (fields.MsgId) return `wecom:${fields.MsgId}`;
    return `wecom:${fields.FromUserName ?? ""}:${fields.CreateTime ?? ""}`;
  }
}
