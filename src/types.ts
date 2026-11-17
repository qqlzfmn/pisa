export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface IncomingMessage {
  eventId: string;
  channel: string;
  chatId: string;
  userId: string;
  text: string;
  repo?: string;
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

export interface ChannelAdapter {
  name: string;
  start(onMessage: (m: IncomingMessage) => Promise<void> | void): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
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
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to);
}
