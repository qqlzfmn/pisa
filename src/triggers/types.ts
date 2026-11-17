import type { IncomingMessage } from "../types";

/** 一次入站请求：请求体保持原文，签名按原文计算 */
export interface TriggerRequest {
  headers: Record<string, string>;
  body: string;
}

/** 归一化后的事件：dedupeKey 即消息的 eventId，由 Router 的 claimEvent 唯一占位 */
export interface TriggerEvent {
  dedupeKey: string;
  message: IncomingMessage;
}

export type TriggerVerdict = { ok: true } | { ok: false; status: number; error: string };

export type NormalizeResult = { ok: true; events: TriggerEvent[] } | { ok: false; status: number; error: string };

export interface TriggerReply {
  status: number;
  body: string;
  contentType: string;
}

/**
 * 一个事件来源的协议适配器：握手 → 验签 → 归一化。
 * 三个步骤都返回结果而不是抛异常，分发层不需要把业务逻辑包在 try/catch 里。
 */
export interface TriggerAdapter {
  /** 来源名，进入 IncomingMessage.channel */
  name: string;
  /** URL 末段：POST /triggers/<path> */
  path: string;
  /** 协议握手（如飞书 URL 校验）：返回响应即结束，不进入验签与归一化 */
  handshake(req: TriggerRequest): TriggerReply | null;
  verify(req: TriggerRequest): TriggerVerdict;
  normalize(req: TriggerRequest): NormalizeResult;
}

/** 与服务同生命周期的被动来源（文件监听），与 HTTP 适配器共用投递入口 */
export interface TriggerSource {
  start(): void;
  stop(): void;
}

export function textReply(status: number, body: string): TriggerReply {
  return { status, body, contentType: "text/plain; charset=utf-8" };
}

export function jsonReply(status: number, body: unknown): TriggerReply {
  return { status, body: JSON.stringify(body), contentType: "application/json" };
}
