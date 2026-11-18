import type { Store } from "./store";
import type { QueuedEffect } from "./types";

/** 第一次失败后的等待 */
export const EFFECT_BACKOFF_BASE_MS = 2_000;
/** 退避上限 */
export const EFFECT_BACKOFF_MAX_MS = 60_000;

/** 第 attempts 次失败后的等待：2s 起每次翻倍，封顶 60s */
export function effectBackoffMs(attempts: number): number {
  if (attempts < 1) return 0;
  return Math.min(EFFECT_BACKOFF_BASE_MS * 2 ** (attempts - 1), EFFECT_BACKOFF_MAX_MS);
}

export interface EffectContext {
  taskId: string | null;
}

/** 执行器：成功返回结果（落库），抛错即失败并进入退避 */
export type EffectHandler = (payload: unknown, ctx: EffectContext) => unknown | Promise<unknown>;

export interface EffectQueueDeps {
  store: Store;
  now?: () => number;
}

/**
 * 外部动作队列：动作先落库，再按 (kind, key) 只执行一次，失败退避重试，重启后继续。
 * 执行器由动作的拥有者注册；队列不认识业务类型。
 */
export class EffectQueue {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly handlers = new Map<string, EffectHandler>();
  /** 串行化：外部命令是阻塞调用，同一行不能被并发执行 */
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: EffectQueueDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
  }

  /** 注册某类动作的执行器；同类重复注册以最后一次为准 */
  register(kind: string, handler: EffectHandler): void {
    this.handlers.set(kind, handler);
  }

  /** 落库；同 (kind, key) 已有记录时什么都不做 */
  enqueue(kind: string, key: string, payload: unknown, taskId: string | null = null): void {
    this.store.enqueueEffect(kind, key, payload, taskId, this.now());
  }

  state(kind: string, key: string): QueuedEffect | null {
    return this.store.effectRow(kind, key);
  }

  /** 立刻尝试一次；已完成返回 true，仍需重试返回 false */
  flush(kind: string, key: string): Promise<boolean> {
    return this.serial(async () => {
      const row = this.store.effectRow(kind, key);
      if (!row) return false;
      if (row.state === "done") return true;
      return this.runOnce(row);
    });
  }

  /** 执行所有到期动作，返回本次尝试的条数 */
  drainDue(): Promise<number> {
    return this.serial(async () => {
      let n = 0;
      for (const row of this.store.dueEffects(this.now())) {
        if (!this.handlers.has(row.kind)) continue;
        await this.runOnce(row);
        n += 1;
      }
      return n;
    });
  }

  /** 启动重试循环：遗留 running 退回 pending，之后每秒扫一次到期动作 */
  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.store.resetRunningEffects(this.now());
    this.timer = setInterval(() => void this.drainDue(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    await this.chain;
  }

  private async runOnce(row: QueuedEffect): Promise<boolean> {
    const handler = this.handlers.get(row.kind);
    if (!handler) return false;
    const claimed = this.store.claimEffect(row.kind, row.key, this.now());
    if (!claimed) return this.store.effectRow(row.kind, row.key)?.state === "done";
    try {
      const result = await handler(claimed.payload, { taskId: claimed.taskId });
      this.store.completeEffect(row.kind, row.key, result, this.now());
      return true;
    } catch (err) {
      const attempts = claimed.attempts + 1;
      const nextAt = this.now() + effectBackoffMs(attempts);
      this.store.failEffect(row.kind, row.key, (err as Error).message || String(err), nextAt, this.now());
      return false;
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
