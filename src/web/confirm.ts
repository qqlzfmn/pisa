import { randomBytes } from "node:crypto";

interface Pending {
  payload: string;
  at: number;
}

const TTL_MS = 5 * 60 * 1000;

/**
 * 写操作的二次确认：预览时签发令牌，执行时消费一次。
 * 令牌绑定动作、目标与请求体，防止「预览 A 保存 B」。
 */
export class Confirmations {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly ttlMs = TTL_MS, private readonly now: () => number = Date.now) {}

  issue(action: string, target: string, payload: unknown): string {
    this.sweep();
    const token = randomBytes(16).toString("hex");
    this.pending.set(`${action}\u0000${target}\u0000${token}`, {
      payload: JSON.stringify(payload),
      at: this.now(),
    });
    return token;
  }

  /** 校验并删除令牌；任何不匹配都视为失效 */
  consume(action: string, target: string, token: string, payload: unknown): boolean {
    const key = `${action}\u0000${target}\u0000${token}`;
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.pending.delete(key);
    if (this.now() - entry.at > this.ttlMs) return false;
    return entry.payload === JSON.stringify(payload);
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.pending) {
      if (entry.at < cutoff) this.pending.delete(key);
    }
  }
}
