import type { EffectRow, Store } from "./store";

/** 需要「先落库再执行」的外部动作 */
export type OutboxKind = "push" | "pr" | "comment";

export interface PushPayload {
  taskId: string;
  /** 主仓库路径：任务成功后工作副本会被删，重试不能依赖它 */
  repoPath: string;
  branch: string;
}

export interface PrPayload {
  taskId: string;
  repoPath: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  /** 仓库别名，回填账本用 */
  repo: string;
}

export interface CommentPayload {
  taskId: string;
  repo: string;
  number: number;
  purpose: "pr" | "issue";
  body: string;
}

export interface OutboxPayloads {
  push: PushPayload;
  pr: PrPayload;
  comment: CommentPayload;
}

/** 各类动作返回什么：push 无结果，pr 返回链接，comment 返回是否真的发出 */
export interface OutboxResults {
  push: null;
  pr: { url: string | null };
  comment: "posted" | "skipped";
}

export type EffectHandler<K extends OutboxKind> = (payload: OutboxPayloads[K]) => Promise<OutboxResults[K]>;

/** 退避基数与上限：2s 起，逐次翻倍，60s 封顶 */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
/** 连续失败达到该次数后终止，不再重试 */
const MAX_ATTEMPTS = 10;
/** 单轮最多执行的行数，避免一次 flush 长时间占用 */
const FLUSH_BATCH = 20;

/** 第 n 次失败后的等待时间：2s、4s、8s、16s、32s、60s、60s… */
export function effectBackoff(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (Math.max(1, attempts) - 1), BACKOFF_MAX_MS);
}

export interface EffectQueueDeps {
  now?: () => number;
  /** 后台重试失败回调；默认打一行日志 */
  onError?: (row: EffectRow, err: unknown) => void;
}

/**
 * 外部动作的 outbox：动作先写 effects 行再执行，同一 (kind, key) 只执行一次；
 * 失败按指数退避留在库里，进程重启后由 flush 继续。
 * 外部动作本身仍需幂等：崩溃在「动作成功、标记完成」之间时同一行会再执行一次。
 */
export class EffectQueue {
  private readonly handlers = new Map<OutboxKind, (payload: unknown) => Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  /** 正在执行的行：exec 与 flush 撞上同一行时共用一个结果，不重复动作 */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly deps: EffectQueueDeps = {},
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  register<K extends OutboxKind>(kind: K, handler: EffectHandler<K>): this {
    this.handlers.set(kind, handler as (payload: unknown) => Promise<unknown>);
    return this;
  }

  /**
   * 确保一次外部动作最终发生：先落库，已完成直接返回上次结果，否则立刻执行一次。
   * 执行失败会抛出（调用方据此保留现有分支行为），行留在库里等后台重试。
   */
  async exec<K extends OutboxKind>(
    kind: K,
    key: string,
    taskId: string | null,
    payload: OutboxPayloads[K],
  ): Promise<OutboxResults[K]> {
    const row = this.store.enqueueEffect({ kind, key, taskId, payload: JSON.stringify(payload), at: this.now() });
    if (row.status === "done") return (row.result === null ? null : JSON.parse(row.result)) as OutboxResults[K];
    if (row.status === "failed") throw new Error(`effect ${kind}:${key} 已终止：${row.lastError ?? ""}`);
    return (await this.dispatch(kind, row)) as OutboxResults[K];
  }

  /** 执行所有到期且已注册处理器的未完成行 */
  async flush(): Promise<{ done: number; failed: number }> {
    if (this.flushing) return { done: 0, failed: 0 };
    const kinds = [...this.handlers.keys()];
    if (kinds.length === 0) return { done: 0, failed: 0 };
    this.flushing = true;
    let done = 0;
    let failed = 0;
    try {
      for (const row of this.store.dueEffects(this.now(), kinds, FLUSH_BATCH)) {
        if (this.inFlight.has(`${row.kind}:${row.key}`)) continue;
        try {
          await this.dispatch(row.kind as OutboxKind, row);
          done += 1;
        } catch (err) {
          failed += 1;
          this.report(row.kind, row.key, err);
        }
      }
    } finally {
      this.flushing = false;
    }
    return { done, failed };
  }

  /** 启动时立即重放一轮未完成的行，之后按间隔继续 */
  start(intervalMs = 1000): void {
    this.stop();
    void this.flush();
    this.timer = setInterval(() => void this.flush(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  /** 任务失败或取消：丢弃它未完成的 effect，避免对着已删除的工作副本重试 */
  cancelTask(taskId: string): number {
    return this.store.dropPendingEffects(taskId);
  }

  /** 同一行只跑一份：已经在执行的直接复用它的结果 */
  private dispatch(kind: OutboxKind, row: EffectRow): Promise<unknown> {
    const id = `${kind}:${row.key}`;
    const running = this.inFlight.get(id);
    if (running) return running;
    const task = this.run(kind, row).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, task);
    return task;
  }

  private async run(kind: OutboxKind, row: EffectRow): Promise<unknown> {
    const handler = this.handlers.get(kind);
    if (!handler) throw new Error(`没有注册 ${kind} 处理器`);
    // flush 拿到的是到期行快照：轮到这一行时，它可能已被并发的 exec 或上一轮做完
    const current = this.store.effectRow(kind, row.key) ?? row;
    if (current.status === "done") return current.result === null ? null : JSON.parse(current.result);
    if (current.status === "failed") throw new Error(`effect ${kind}:${row.key} 已终止：${current.lastError ?? ""}`);
    try {
      const result = await handler(JSON.parse(current.payload));
      this.store.completeEffect(kind, row.key, JSON.stringify(result ?? null), this.now());
      return result;
    } catch (err) {
      const attempts = current.attempts + 1;
      this.store.failEffect(
        kind,
        row.key,
        (err instanceof Error ? err.message : String(err)).slice(0, 500),
        { nextAt: this.now() + effectBackoff(attempts), terminal: attempts >= MAX_ATTEMPTS },
        this.now(),
      );
      throw err;
    }
  }

  private report(kind: string, key: string, err: unknown): void {
    const row = this.store.effectRow(kind, key);
    const message = err instanceof Error ? err.message : String(err);
    if (this.deps.onError && row) {
      this.deps.onError(row, err);
      return;
    }
    console.error(`[pisa] effect ${kind}:${key} 失败：${message}`);
  }
}
