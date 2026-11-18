export type TaskStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled" | "rewound";

/** 任务对外产生的副作用种类：rewind 的依据 */
export type EffectKind = "branch" | "push" | "pr" | "comment" | "worktree" | "merge";

export interface Effect {
  taskId: string;
  kind: EffectKind;
  /** 分类内唯一的对象标识：分支名、远程名（如 origin）、PR 编号、仓库#编号、工作目录、主干名 */
  target: string;
  /** 附加信息：分支账本存 `shared`（与上一轮共用）；push 存被推送的分支；merge 存 {"base","from","to"} */
  detail: string | null;
  createdAt: number;
}

/** Outbox 行状态：pending 待执行、running 执行中、done 已成功或已取消 */
export type EffectState = "pending" | "running" | "done";

/** 一条待执行的外部动作；payload 与 result 是落库的 JSON 值 */
export interface QueuedEffect {
  kind: string;
  key: string;
  taskId: string | null;
  payload: unknown;
  state: EffectState;
  /** 已失败次数；决定下一次退避时长 */
  attempts: number;
  /** 最早可执行时间 */
  nextAt: number;
  lastError: string | null;
  result: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface IncomingMessage {
  eventId: string;
  channel: string;
  chatId: string;
  userId: string;
  text: string;
  repo?: string;
  /** 私聊（一对一）消息 */
  isDirect?: boolean;
  /**
   * 入口已完成本地鉴权（web 用 token 认证操作者）：
   * 跳过单英文词误触防护与原请求者校验，IM 消息不带此字段。
   */
  admin?: boolean;
  /** 回复的是哪条消息（用于接续对应任务） */
  replyToMessageId?: number;
  /** 直接续跑这个任务，跳过命令里的任务号（PR 评论绑定用） */
  continueFrom?: string;
  /** 任务完成后回帖到该 PR */
  replyPr?: number;
  /** 任务完成后回帖到该 Issue（与 replyPr 互斥） */
  replyIssue?: number;
  /** 回帖目标仓库（owner/repo）；缺省时用 github 配置的单仓库 */
  replyRepo?: string;
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
  /** 回帖目标仓库；null 表示回退到 github 配置的单仓库 */
  replyRepo: string | null;
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
  /** 支持命令菜单的通道（Telegram）用它注册；不支持可以不实现 */
  setCommands?(commands: ReadonlyArray<{ command: string; description: string }>): Promise<void>;
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
  // 终态任务可被 rewind 标记；rewound 自身不可再迁出
  succeeded: ["rewound"],
  failed: ["rewound"],
  cancelled: ["rewound"],
  rewound: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to);
}
