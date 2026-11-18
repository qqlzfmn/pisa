import type { IncomingMessage } from "../types";

/** HTTP 入口的原始输入：验签需要未被消化过的正文，所以 body 保持字符串 */
export interface HttpTriggerRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

/** 入口拒绝：status 与原因回给对端，拒绝的事件不建任务 */
export class TriggerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 协议级回执：飞书的 challenge、企业微信的 success 都不是 JSON，由适配器自己定 */
export interface TriggerReply {
  body: string;
  contentType: string;
}

export interface TriggerEvent {
  message: IncomingMessage;
  /** 去重键：同一外部事件重复投递命中同一个键，进 messageKey */
  dedupeKey: string;
}

/** reply 只回执不建任务；event 为空表示这次事件不需要处理 */
export interface TriggerOutcome {
  reply?: TriggerReply;
  event?: TriggerEvent;
}

/**
 * 通用触发适配器：三件事各有唯一落点。
 *
 * - `verify`：鉴权与解析原始输入，失败抛 `TriggerError`（401/400）
 * - `normalize`：白名单与协议语义，产物是 core 认识的 `IncomingMessage`；返回 null 表示忽略
 * - `dedupeKey`：同一条外部事件的所有重投都命中同一个键
 */
export interface TriggerAdapter<Raw, Payload> {
  readonly name: string;
  verify(raw: Raw): Promise<Payload>;
  normalize(payload: Payload): TriggerOutcome | null;
  dedupeKey(payload: Payload): string;
}

/**
 * 入口统一流程：验证 → 归一化 → 补去重键 → 交给 Router。
 * core 只认归一化后的消息，不关心外部协议。
 */
export async function dispatch<Raw, Payload>(
  adapter: TriggerAdapter<Raw, Payload>,
  raw: Raw,
  handle: (msg: IncomingMessage) => Promise<void>,
): Promise<TriggerOutcome | null> {
  const payload = await adapter.verify(raw);
  const outcome = adapter.normalize(payload);
  if (!outcome?.event) return outcome;
  const { message, dedupeKey } = outcome.event;
  await handle({ ...message, messageKey: message.messageKey ?? dedupeKey });
  return outcome;
}

/** 正文带上触发词：入口给的是需求本身，命令解析仍是 Router 的事 */
export function commandText(trigger: string, body: string): string {
  const text = body.trim();
  return text.startsWith(trigger) ? text : `${trigger} ${text}`;
}
