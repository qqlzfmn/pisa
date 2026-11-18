import type { IncomingMessage } from "./types";

/**
 * 一次触发的身份。
 *
 * 入口把事件原样交给 core，core 只认这组字段：
 * 同一条消息的重复投递（replay、多入口转发）命中同一 `id`，
 * 同一消息的新版本（编辑）只差 `version` 与 `payloadHash`，落到同一任务。
 */
export interface Trigger {
  id: string;
  /** 入口名（telegram / github / webhook / cli / cron …） */
  source: string;
  /** 会话线程：同一线程的后续消息归到这里 */
  threadKey: string;
  /** 线程内的消息标识（评论 id、消息 id、事件 id） */
  messageKey: string;
  /** 触发者：入口侧的真实发起人，缺省时调用方传请求者 */
  actor: string;
  at: number;
  payloadHash: string;
  /** 消息版本：编辑时间等；没有版本概念时为空串 */
  version: string;
}

/** 落库后的触发记录：身份之外还有它归属的任务与用途 */
export interface TriggerRecord extends Trigger {
  kind: "task" | "context";
  /** 归属任务；任务的创建记录与编辑留痕都指向已有任务 */
  taskId: string | null;
}

export interface TriggerInput extends Omit<Trigger, "id" | "payloadHash" | "version"> {
  /** 触发正文：任务命令取解析后的需求，其余取原文 */
  text: string;
  version?: string;
}

/** 带长度前缀的 sha256，拼接多段不产生歧义 */
function digest(...parts: string[]): string {
  const hash = new Bun.CryptoHasher("sha256");
  for (const part of parts) hash.update(`${part.length}:${part}`);
  return hash.digest("hex").slice(0, 32);
}

/** 载荷指纹忽略行尾差异：同一条消息经不同入口搬运后仍应命中 */
export function payloadHash(text: string): string {
  return digest(text.replace(/\r\n/g, "\n").trim());
}

export function makeTrigger(input: TriggerInput): Trigger {
  const version = input.version ?? "";
  const hash = payloadHash(input.text);
  return {
    id: digest(input.source, input.threadKey, input.messageKey, version, hash),
    source: input.source,
    threadKey: input.threadKey,
    messageKey: input.messageKey,
    actor: input.actor,
    at: input.at,
    payloadHash: hash,
    version,
  };
}

/** 线程键：入口显式声明优先，其次回落到被回复的任务，最后按消息独立成线程 */
export function threadKeyOf(msg: IncomingMessage, replyTaskId: string | null): string {
  if (msg.threadKey) return msg.threadKey;
  if (replyTaskId) return `task:${replyTaskId}`;
  return `${msg.channel}:${msg.chatId}:${msg.eventId}`;
}
