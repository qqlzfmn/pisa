export type TaskStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export interface IncomingMessage {
  eventId: string;
  channel: string;
  chatId: string;
  userId: string;
  text: string;
  repo?: string;
  /** 私聊（一对一）消息 */
  isDirect?: boolean;
  /** 回复的是哪条消息（用于接续对应任务） */
  replyToMessageId?: number;
  /** 直接续跑这个任务，跳过命令里的任务号（PR 评论绑定用） */
  continueFrom?: string;
  /** 任务完成后回帖到该 PR */
  replyPr?: number;
  /** 任务完成后回帖到该 Issue（与 replyPr 互斥） */
  replyIssue?: number;
  receivedAt?: number;
}

export interface Task {
  id: string;
  source: string;
  channel: string;
  chatId: string;
  requester: string;
  repo: string;
  prompt: string;
  status: TaskStatus;
  branch: string | null;
  prUrl: string | null;
  sessionId: string | null;
  /** 续跑时的起点分支（上一轮的分支） */
  baseRef: string | null;
  /** 上一轮任务的上下文，注入 Worker 提示词 */
  context: string | null;
  /** 任务完成后回帖到该 PR；null 表示不回帖 */
  replyPr: number | null;
  /** 任务完成后回帖到该 Issue；null 表示不回帖 */
  replyIssue: number | null;
  summary: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  cancelRequested: boolean;
}

export interface WorkerResult {
  ok: boolean;
  summary: string;
  error?: string;
  exitCode: number;
}

/** 发送回执：拿到消息 id 才能把「回复」绑定回任务 */
export interface DeliveryReceipt {
  messageId?: string;
}

export interface ChannelAdapter {
  name: string;
  start(onMessage: (m: IncomingMessage) => Promise<void> | void): Promise<void>;
  send(chatId: string, text: string): Promise<DeliveryReceipt | void>;
  stop(): Promise<void>;
}

export interface DeliveryResult {
  branch?: string;
  prUrl?: string;
  files: string[];
  pushed: boolean;
}

/** 状态机允许的跃迁，唯一事实源 */
export const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["paused", "succeeded", "failed", "cancelled"],
  // 中断：进程重启时从 running 转入；只能由请求者恢复或放弃
  paused: ["running", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to);
}
