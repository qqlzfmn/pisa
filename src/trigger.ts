import { createHash } from "node:crypto";

/** 正文摘要：折叠空白后取 sha256 前 16 位；编辑消息据此判定是否新版本 */
export function payloadHash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

/** 线程键：入口给出的会话标识；缺省时事件自成线程 */
export function threadKeyOf(msg: { threadKey?: string; channel: string; eventId: string }): string {
  return msg.threadKey ?? `${msg.channel}:${msg.eventId}`;
}

/** 回填旧任务时还原线程键，规则与各入口一致，保证回填记录能和新触发归并 */
export function legacyThreadKey(row: {
  channel: string;
  chatId: string;
  source: string;
  replyRepo: string | null;
  replyPr: number | null;
  replyIssue: number | null;
}): string {
  if (row.channel === "telegram") return `telegram:${row.chatId}`;
  if (row.channel === "github") {
    const n = row.replyPr ?? row.replyIssue;
    if (row.replyRepo && n !== null) return `github:${row.replyRepo}:${n}`;
  }
  // cron / webhook / cli 的事件标识本身带入口前缀时，事件自成线程
  if (row.source.startsWith(`${row.channel}:`)) return row.source;
  return `${row.channel}:${row.source}`;
}
