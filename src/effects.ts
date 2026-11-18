import type { CreatePrOptions, ExecResult } from "./git";
import { createPr, pushBranch, sh } from "./git";
import type { Store } from "./store";
import type { OutboxKind, QueuedEffect } from "./types";

/** 首次失败后等 2s，之后每次翻倍，封顶 60s */
export const EFFECT_BASE_DELAY_MS = 2_000;
export const EFFECT_MAX_DELAY_MS = 60_000;

/** 第 attempts 次失败后的等待时长 */
export function effectDelay(attempts: number, base = EFFECT_BASE_DELAY_MS, max = EFFECT_MAX_DELAY_MS): number {
  return Math.min(base * 2 ** Math.max(0, attempts - 1), max);
}

export interface PushPayload {
  taskId: string;
  /** 主仓库目录：工作副本会被清理，重放时从这里推 */
  repoPath: string;
  branch: string;
}

export interface PrPayload {
  taskId: string;
  /** 仓库别名：PR 账本按别名记 detail */
  alias: string;
  repoPath: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

export interface CommentPayload {
  taskId: string;
  repo: string;
  number: number;
  purpose: "pr" | "issue";
  body: string;
}

export type EffectHandler = (payload: unknown) => Promise<unknown>;
export type EffectHandlers = Partial<Record<OutboxKind, EffectHandler>>;

export type EffectRun = { ok: true; result: unknown } | { ok: false; error: string };

export interface DeliveryEffectDeps {
  createPr?: (workdir: string, opts: CreatePrOptions) => ExecResult;
  findPr?: (repoPath: string, head: string) => string | null;
}

/** 分支上已有的 PR 链接；查询失败按「没有」处理，交给 createPr 再判一次 */
export function findPrForBranch(repoPath: string, head: string): string | null {
  const res = sh(["gh", "pr", "list", "--head", head, "--state", "all", "--json", "url", "--jq", ".[0].url"], repoPath);
  if (res.code !== 0) return null;
  return res.out.split("\n")[0]?.trim() || null;
}

/**
 * push / PR 的 effect 实现。PR 先按 head 分支查已有 PR：
 * 上次建完 PR 还没落库就崩了，重放会复用那个 PR 而不是再建一个。
 */
export function deliveryEffectHandlers(deps: DeliveryEffectDeps = {}): EffectHandlers {
  const find = deps.findPr ?? findPrForBranch;
  const create = deps.createPr ?? createPr;
  return {
    async push(raw: unknown): Promise<unknown> {
      const p = raw as PushPayload;
      const res = pushBranch(p.repoPath, p.branch);
      if (res.code !== 0) throw new Error(`推送失败: ${res.err || res.out}`);
      return { branch: p.branch };
    },
    async pr(raw: unknown): Promise<unknown> {
      const p = raw as PrPayload;
      const existing = find(p.repoPath, p.head);
      if (existing) return existing;
      const res = create(p.repoPath, { title: p.title, body: p.body, base: p.base, head: p.head });
      const url = res.code === 0 ? (res.out.split("\n").pop() ?? "").trim() : "";
      if (!url) throw new Error(`PR 创建失败: ${res.err || res.out || "无输出"}`);
      return url;
    },
  };
}

export interface EffectQueueDeps {
  handlers: EffectHandlers;
  now?: () => number;
  /** 首次执行成功后的回调：Router 用它把动作记进 task_effects 账本 */
  onDone?: (kind: OutboxKind, payload: unknown, result: unknown) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * 外部动作队列：先落库再执行。
 * 同一 (kind, key) 只有一行；执行成功后记结果，重放直接返回结果不再执行。
 */
export class EffectQueue {
  private readonly now: () => number;
  /** 正在执行的 effect：避免同一行被并发执行两次 */
  private readonly running = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(
    private store: Store,
    private deps: EffectQueueDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** 入队；同一 (kind, key) 已存在（含已完成）时返回 false，payload 以首次为准 */
  enqueue(kind: OutboxKind, key: string, payload: unknown): boolean {
    return this.store.enqueueEffect(kind, key, JSON.stringify(payload), this.now());
  }

  /** 立即执行一条；已完成直接返回存下的结果 */
  async runNow(kind: OutboxKind, key: string): Promise<EffectRun> {
    const row = this.store.effectByKey(kind, key);
    if (!row) return { ok: false, error: `effect 不存在：${kind} ${key}` };
    return this.execute(row);
  }

  /** 执行所有到期的 effect，返回执行条数 */
  async runDue(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;
    try {
      let ran = 0;
      for (const row of this.store.dueEffects(this.now())) {
        await this.execute(row);
        ran += 1;
      }
      return ran;
    } finally {
      this.draining = false;
    }
  }

  /** 后台按固定间隔扫到期 effect；重启后由它接着跑上次没完成的 */
  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runDue(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  private async execute(row: QueuedEffect): Promise<EffectRun> {
    if (row.doneAt !== null) return { ok: true, result: parseJson(row.result) };
    if (this.running.has(row.id)) return { ok: false, error: `effect 执行中：${row.kind} ${row.key}` };
    const handler = this.deps.handlers[row.kind];
    if (!handler) return this.fail(row, `未注册的 effect 类型：${row.kind}`);
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch (err) {
      return this.fail(row, `payload 损坏：${(err as Error).message}`);
    }

    this.running.add(row.id);
    try {
      const result = await handler(payload);
      this.store.markEffectDone(row.id, JSON.stringify(result ?? null), this.now());
      this.deps.onDone?.(row.kind, payload, result);
      return { ok: true, result };
    } catch (err) {
      return this.fail(row, (err as Error).message);
    } finally {
      this.running.delete(row.id);
    }
  }

  private fail(row: QueuedEffect, message: string): EffectRun {
    const attempts = row.attempts + 1;
    const nextAt = this.now() + effectDelay(attempts, this.deps.baseDelayMs, this.deps.maxDelayMs);
    this.store.markEffectAttempt(row.id, attempts, nextAt, message.slice(0, 500));
    return { ok: false, error: message };
  }
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
