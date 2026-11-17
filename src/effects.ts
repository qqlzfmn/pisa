import type { Store } from "./store";
import type { EffectJob, EffectJobKind, EffectOutcome } from "./types";

/** 真正的动作实现：成功返回结果字符串（如 PR 地址），失败抛出 */
export type EffectRunner = (job: EffectJob) => Promise<string | null>;

/** 入队方只需要这一个能力 */
export interface EffectEnqueuer {
  enqueue(kind: EffectJobKind, dedupeKey: string, payload: Record<string, unknown>): Promise<EffectOutcome>;
}

export interface EffectQueueOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 最多执行次数（含首次）；默认 7 次，退避 2s→4s→8s→16s→32s→60s */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const MAX_ATTEMPTS = 7;

/**
 * Outbox：外部动作先落库再执行。
 * 同一 (kind, dedupeKey) 只执行一次；失败按指数退避重试，次数用尽标 failed；
 * 进程在「已落库、未完成」之间崩溃时，重启后由 pendingEffects 重放。
 */
export class EffectQueue implements EffectEnqueuer {
  private readonly inflight = new Map<string, Promise<EffectOutcome>>();
  private readonly stoppedSignal = Promise.withResolvers<void>();
  private stopped = false;
  private readonly now: () => number;
  private readonly customSleep?: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(
    private readonly store: Store,
    private readonly run: EffectRunner,
    opts: EffectQueueOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.customSleep = opts.sleep;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? MAX_ATTEMPTS);
    this.retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = opts.retryMaxMs ?? RETRY_MAX_MS;
  }

  async enqueue(
    kind: EffectJobKind,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<EffectOutcome> {
    const id = `${kind}:${dedupeKey}`;
    const running = this.inflight.get(id);
    if (running) return running;

    const job = this.store.enqueueEffect(kind, dedupeKey, payload, this.now());
    if (job.status === "done") return { ok: true, result: job.result };
    if (this.stopped) return { ok: false, error: "进程关停，effect 待重放" };

    const p = this.runJob(job).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  /** 重放上次进程遗留的未完成 effect，返回条数；不阻塞启动 */
  replay(): number {
    if (this.stopped) return 0;
    const jobs = this.store.pendingEffects();
    for (const job of jobs) void this.enqueue(job.kind, job.dedupeKey, job.payload);
    return jobs.length;
  }

  /** 关停：正在退避等待的 effect 留在 pending，下次启动重放 */
  stop(): void {
    this.stopped = true;
    this.stoppedSignal.resolve();
  }

  private async runJob(job: EffectJob): Promise<EffectOutcome> {
    let attempts = job.attempts;
    let nextAt = job.nextAt;
    for (;;) {
      if (this.stopped) return { ok: false, error: "进程关停，effect 待重放" };
      const wait = nextAt - this.now();
      if (wait > 0) {
        await this.sleep(wait);
        // 等待期间被关停：不再执行，留给下次启动重放
        if (this.stopped) return { ok: false, error: "进程关停，effect 待重放" };
      }
      attempts += 1;
      try {
        const result = await this.run(job);
        this.store.settleEffect(job.id, "done", result, null, this.now());
        return { ok: true, result };
      } catch (err) {
        const error = (err as Error).message;
        if (attempts >= this.maxAttempts) {
          this.store.settleEffect(job.id, "failed", null, error, this.now());
          return { ok: false, error };
        }
        nextAt = this.now() + this.delay(attempts);
        this.store.deferEffect(job.id, attempts, nextAt, error, this.now());
      }
    }
  }

  /** 第 n 次失败后的等待：base·2^(n-1)，封顶 retryMaxMs */
  private delay(attempts: number): number {
    return Math.min(this.retryBaseMs * 2 ** (attempts - 1), this.retryMaxMs);
  }

  private sleep(ms: number): Promise<void> {
    if (this.customSleep) return this.customSleep(ms);
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, ms);
    void this.stoppedSignal.promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
    return promise;
  }
}
