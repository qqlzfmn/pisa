/** 触发适配器只读的 HTTP 快照；body 保持原始文本，签名必须对原文计算 */
export interface TriggerRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export type TriggerVerdict = { ok: true } | { ok: false; status: number; reason: string };

/** 归一化后的事件：externalId 是来源自己的稳定标识，不含通道前缀 */
export interface TriggerPayload {
  externalId: string;
  text: string;
  /** 任务归属与回执目标，语义同 webhook */
  chatId: string;
  userId: string;
  /** 本地仓库别名；缺省用默认仓库 */
  repo?: string;
}

export interface TriggerReply {
  status: number;
  body?: string;
  contentType?: string;
}

export type TriggerOutcome =
  | { kind: "event"; payload: TriggerPayload; ack?: TriggerReply }
  | { kind: "reply"; reply: TriggerReply }
  | { kind: "ignore"; reason: string }
  | { kind: "reject"; status: number; reason: string };

/**
 * 外部事件 → 任务的三段式契约：
 * verify 校验来源，normalize 归一化载荷，dedupeKey 生成跨重启稳定的去重键。
 * 状态与调度仍归 Router，适配器不碰数据库。
 */
export interface TriggerAdapter {
  readonly name: string;
  verify(req: TriggerRequest): TriggerVerdict;
  normalize(req: TriggerRequest): TriggerOutcome;
  dedupeKey(payload: TriggerPayload): string;
}
