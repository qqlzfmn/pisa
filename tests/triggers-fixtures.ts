import { createCipheriv, createHash, createHmac } from "node:crypto";
import { DEFAULT_WEB, type Config } from "../src/config";

export const GITHUB_SECRET = "s3cret";
export const FEISHU_TOKEN = "feishu-token";
export const FEISHU_KEY = "feishu-encrypt-key";
export const WECOM_TOKEN = "wecom-token";
export const WECOM_CORP = "ww-corp";
export const WECOM_AES_KEY = Buffer.alloc(32, 7).toString("base64").slice(0, 43);

export function signGithub(body: string, secret = GITHUB_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** 飞书：AES-256-CBC，key=SHA256(Encrypt Key)，IV 随密文前置，PKCS#7 */
export function encryptFeishu(plain: string, keyText = FEISHU_KEY): string {
  const key = createHash("sha256").update(keyText, "utf8").digest();
  const iv = Buffer.alloc(16, 3);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(Buffer.from(plain, "utf8")), cipher.final()]).toString("base64");
}

export function feishuPayload(overrides: {
  eventId?: string;
  chatId?: string;
  chatType?: "p2p" | "group";
  openId?: string;
  text?: string;
  content?: string;
  mentions?: unknown[];
  token?: string;
} = {}): Record<string, unknown> {
  return {
    schema: "2.0",
    header: {
      event_id: overrides.eventId ?? "ev-1",
      event_type: "im.message.receive_v1",
      token: overrides.token ?? FEISHU_TOKEN,
    },
    event: {
      sender: { sender_id: { open_id: overrides.openId ?? "ou-1" } },
      message: {
        message_id: "om-1",
        chat_id: overrides.chatId ?? "oc-1",
        chat_type: overrides.chatType ?? "p2p",
        message_type: "text",
        content: overrides.content ?? JSON.stringify({ text: overrides.text ?? "修一下登录" }),
        ...(overrides.mentions ? { mentions: overrides.mentions } : {}),
      },
    },
  };
}

/** 企业微信：AES-256-CBC，key=Base64(EncodingAESKey+"=")，IV=key 前 16 字节，补位块 32 */
export function encryptWecom(msg: string, receiveId = WECOM_CORP, aesKey = WECOM_AES_KEY): string {
  const key = Buffer.from(aesKey.endsWith("=") ? aesKey : `${aesKey}=`, "base64");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(Buffer.byteLength(msg, "utf8"));
  const raw = Buffer.concat([Buffer.alloc(16, 5), length, Buffer.from(msg, "utf8"), Buffer.from(receiveId, "utf8")]);
  const pad = 32 - (raw.length % 32);
  const plain = Buffer.concat([raw, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
}

export function wecomSignature(encrypt: string, token = WECOM_TOKEN): string {
  const timestamp = "1700000000";
  const nonce = "nonce-1";
  const signature = createHash("sha1")
    .update([token, timestamp, nonce, encrypt].sort().join(""), "utf8")
    .digest("hex");
  return `msg_signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`;
}

export function wecomXml(encrypt: string): string {
  return `<xml><ToUserName><![CDATA[${WECOM_CORP}]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`;
}

export function wecomMessage(overrides: { msgId?: string; content?: string; from?: string; msgType?: string } = {}): string {
  return `<xml><ToUserName><![CDATA[${WECOM_CORP}]]></ToUserName><FromUserName><![CDATA[${overrides.from ?? "zhangsan"}]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[${overrides.msgType ?? "text"}]]></MsgType><Content><![CDATA[${overrides.content ?? "修一下构建"}]]></Content><MsgId>${overrides.msgId ?? "9001"}</MsgId><AgentID>1000002</AgentID></xml>`;
}

export function baseConfig(): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: "/tmp/demo" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    web: { ...DEFAULT_WEB, enabled: false },
    stateDir: "/tmp/pisa-triggers",
  };
}
