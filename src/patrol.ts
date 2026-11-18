import { createHash } from "node:crypto";
import type { Config } from "./config";
import type { IncomingMessage } from "./types";
import { OPS_EXIT, OPS_EXIT_LABEL, formatOpsIssues, type OpsStatus } from "./ops-status";

type Enqueue = (m: IncomingMessage) => Promise<void> | void;

/** 巡检去重状态：签名相同不重复提醒，恢复正常后清空 */
export const PATROL_META_KEY = "patrol:status";
/** 默认每小时一次 */
export const PATROL_INTERVAL_SEC = 3600;

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/** 巡检结果的身份：问题集合不变就视为同一件事 */
export function patrolSignature(ops: OpsStatus): string {
  return ops.issues
    .map((i) => i.key)
    .sort()
    .join("|");
}

/** 投递身份：显式巡检配置优先，其次复用定时任务的发送方 */
export function patrolIdentity(cfg: Config): { chatId: string; userId: string; repo?: string } | null {
  const patrol = cfg.proactive?.patrol;
  const chatId = patrol?.chatId ?? cfg.scheduler?.chatId;
  const userId = patrol?.userId ?? cfg.scheduler?.userId;
  if (!chatId || !userId) return null;
  return { chatId, userId, repo: patrol?.repo };
}

export interface PatrolDeps {
  cfg: Config;
  /** 只读写 meta：生产传 Store，测试传内存实现 */
  store: Pick<ConfigStore, "getMeta" | "setMeta">;
  enqueue: Enqueue;
  /** 与 CLI 共用的判定；index 传入 evaluateOpsStatus */
  evaluate: () => OpsStatus;
  now?: () => number;
}

/** 巡检只需要 meta 的键值读写 */
interface ConfigStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

export function formatPatrolMessage(ops: OpsStatus): string {
  return [
    `pisa 状态异常（${ops.exitCode} ${OPS_EXIT_LABEL[ops.exitCode]}）`,
    ...formatOpsIssues(ops.issues),
    "巡检每小时一次；同一问题恢复前不再提醒。",
  ].join("\n");
}

/**
 * 每小时状态巡检：正常静默，异常投递一条消息并落签名。
 * 签名不变就不重复投递；退出码回到 0 时清空签名，下次再坏重新提醒。
 */
export class StatusPatrol {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PatrolDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.deps.cfg.proactive?.patrol?.enabled === false) return;
    const identity = patrolIdentity(this.deps.cfg);
    if (!identity) {
      console.warn("[pisa] 状态巡检未启动：缺少 proactive.patrol.chatId/userId 或 scheduler 身份");
      return;
    }
    this.tick(identity);
    const every = Math.max(60, this.deps.cfg.proactive?.patrol?.intervalSec ?? PATROL_INTERVAL_SEC) * 1000;
    this.timer = setInterval(() => this.tick(identity), every);
  }

  /** 单轮：签名不变就静默；恢复时清空去重键 */
  tick(identity = patrolIdentity(this.deps.cfg)): void {
    const ops = this.deps.evaluate();
    if (ops.exitCode === OPS_EXIT.ok) {
      if (this.deps.store.getMeta(PATROL_META_KEY)) this.deps.store.setMeta(PATROL_META_KEY, "");
      return;
    }
    if (!identity) return;
    const signature = patrolSignature(ops);
    if (this.deps.store.getMeta(PATROL_META_KEY) === signature) return;
    this.deps.store.setMeta(PATROL_META_KEY, signature);
    void this.deps.enqueue({
      eventId: `patrol:status:${sha1(signature)}:${this.now()}`,
      channel: "proactive",
      chatId: identity.chatId,
      userId: identity.userId,
      repo: identity.repo,
      isDirect: true,
      text: formatPatrolMessage(ops),
    });
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }
}
