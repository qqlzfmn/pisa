import { timingSafeEqual } from "node:crypto";
import { makeTrigger, type Trigger } from "../trigger";

/** 平台回调的原始请求：验签只看原始字节，解析留给归一化 */
export interface TriggerRequest {
  method: string;
  headers: Headers;
  query: URLSearchParams;
  body: string;
}

/** 归一化后的事件身份：与 core 的触发字段一一对应 */
export interface TriggerEvent {
  /** 会话线程：同一线程的后续消息归到这里 */
  threadKey: string;
  /** 线程内消息标识：平台消息 id，比投递 id 稳定 */
  messageKey: string;
  /** 消息版本（编辑时间等）；没有版本概念时为空串 */
  version: string;
  /** 平台侧真实发起人 */
  actor: string;
  /** 事件正文，交给 Router 解析命令 */
  text: string;
  at: number;
}

export type TriggerOutcome =
  | { kind: "event"; event: TriggerEvent; repo?: string }
  /** 合法但不处理：回 200 让平台停止重试 */
  | { kind: "ignore"; reason: string }
  /** 载荷非法或不该被受理：回 4xx */
  | { kind: "reject"; status: number; reason: string }
  /** 平台握手：原样回写 */
  | { kind: "challenge"; body: string; contentType?: string };

/**
 * 通用触发适配器：一个平台一个实现，只做三件事。
 *
 * 1) `verify`——验签与传输层校验，只看原始 body / 头 / 查询串；
 * 2) `normalize`——把平台载荷归一化成 `TriggerEvent`；
 * 3) `dedupeKey`——事件的去重键，与 core 的触发器身份同源。
 *
 * 白名单（仓库、群、用户）在 `normalize` 里过滤：命中不到返回 `ignore`，
 * 命中非法载荷返回 `reject`。
 */
export interface TriggerAdapter {
  readonly name: string;
  verify(req: TriggerRequest): string | null;
  normalize(req: TriggerRequest): TriggerOutcome;
  dedupeKey(event: TriggerEvent): string;
}

export abstract class BaseTriggerAdapter implements TriggerAdapter {
  abstract readonly name: string;
  abstract verify(req: TriggerRequest): string | null;
  abstract normalize(req: TriggerRequest): TriggerOutcome;

  dedupeKey(event: TriggerEvent): string {
    return triggerOf(this.name, event).id;
  }
}

/** 事件在 core 里的触发身份：入口名即 source */
export function triggerOf(source: string, event: TriggerEvent): Trigger {
  return makeTrigger({
    source,
    threadKey: event.threadKey,
    messageKey: event.messageKey,
    actor: event.actor,
    at: event.at,
    text: event.text,
    version: event.version,
  });
}

/** 十六进制摘要常量时间比较：长度不符直接判否，避免抛错泄露信息 */
export function equalHex(expected: string, actual: string | null): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 严格解析 JSON：非对象一律视为非法载荷 */
export function parseJsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
