import type { Config, ScheduleJob } from "./config";
import type { Store } from "./store";
import type { IncomingMessage } from "./types";

type Enqueue = (m: IncomingMessage) => Promise<void> | void;

export type CronMatcher = (date: Date) => boolean;

/** 5 段 cron 的字段定义，顺序即表达式顺序 */
const FIELDS = [
  { min: 0, max: 59 }, // 分
  { min: 0, max: 23 }, // 时
  { min: 1, max: 31 }, // 日
  { min: 1, max: 12 }, // 月
  { min: 0, max: 7 }, // 周，7 等同 0
] as const;

const TICK_MS = 30_000;

const pad = (n: number): string => String(n).padStart(2, "0");

/** 本地时间的分钟标识，用于 eventId */
export function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 解析单个字段；支持 `*`、`*`/n、单值、逗号列表、`a-b`、`a-b/n` */
function parseField(raw: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (!part) return null;
    const pieces = part.split("/");
    if (pieces.length > 2) return null;
    const [range, stepRaw] = pieces;
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) return null;
      step = Number(stepRaw);
      if (step < 1) return null;
    }

    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range!.includes("-")) {
      const bounds = range!.split("-");
      if (bounds.length !== 2) return null;
      if (!/^\d+$/.test(bounds[0]!) || !/^\d+$/.test(bounds[1]!)) return null;
      lo = Number(bounds[0]);
      hi = Number(bounds[1]);
    } else {
      if (stepRaw !== undefined) return null; // `5/2` 不是标准写法
      if (!/^\d+$/.test(range!)) return null;
      lo = Number(range);
      hi = lo;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values.size > 0 ? values : null;
}

/** 非法表达式返回 null */
export function parseCron(expr: string): CronMatcher | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]!.min, FIELDS[i]!.max));
  const [minute, hour, dom, month, dow] = sets;
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) dow.add(0);

  // 日与周都被限定时按标准 cron 取「或」；任一为 `*` 时取「与」
  const domAny = parts[2] === "*";
  const dowAny = parts[4] === "*";

  return (date: Date): boolean => {
    if (!minute.has(date.getMinutes())) return false;
    if (!hour.has(date.getHours())) return false;
    if (!month.has(date.getMonth() + 1)) return false;
    const domHit = dom.has(date.getDate());
    const dowHit = dow.has(date.getDay());
    return domAny || dowAny ? domHit && dowHit : domHit || dowHit;
  };
}

/** 非法表达式一律不命中 */
export function matches(expr: string, date: Date): boolean {
  return parseCron(expr)?.(date) ?? false;
}

export interface SchedulerDeps {
  cfg: Config;
  store: Store;
  enqueue: Enqueue;
  now?: () => number;
}

/**
 * 定时任务：每 30 秒 tick，命中 cron 的 job 投递一条消息，走 Router 的正常链路。
 * 同一分钟的重复触发靠 store.claimEvent 持久化占位挡住，进程重启也不会重投。
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly jobs: Array<{ job: ScheduleJob; match: CronMatcher }> = [];
  private readonly now: () => number;

  constructor(private deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.compile();
  }

  /** 启动时编译一次：非法 cron、重复 id 告警并跳过，不影响其他 job */
  private compile(): void {
    const seen = new Set<string>();
    for (const job of this.deps.cfg.schedules ?? []) {
      if (seen.has(job.id)) {
        console.warn(`[pisa] 定时任务 id 重复：${job.id}，已跳过`);
        continue;
      }
      seen.add(job.id);
      const match = parseCron(job.cron);
      if (!match) {
        console.warn(`[pisa] 定时任务 ${job.id} 的 cron 非法：${job.cron}，已跳过`);
        continue;
      }
      this.jobs.push({ job, match });
    }
  }

  start(): void {
    if (this.timer || this.jobs.length === 0) return;
    const sched = this.deps.cfg.scheduler;
    if (!sched?.chatId || !sched?.userId) {
      console.warn("[pisa] 配置了 schedules 但缺少 scheduler.chatId/userId，定时任务未启用");
      return;
    }
    void this.tick().catch((e) => console.warn(`[pisa] 定时任务 tick 失败：${String(e).slice(0, 300)}`));
    this.timer = setInterval(
      () => void this.tick().catch((e) => console.warn(`[pisa] 定时任务 tick 失败：${String(e).slice(0, 300)}`)),
      TICK_MS,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 检查当前分钟并投递；测试直接调用 */
  async tick(at = new Date(this.now())): Promise<void> {
    const sched = this.deps.cfg.scheduler;
    if (!sched) return;
    const stamp = minuteKey(at);
    for (const { job, match } of this.jobs) {
      if (job.enabled === false || !match(at)) continue;
      // 占位 key 与消息 eventId 分开：这里是入队幂等，触发器表负责建任务幂等
      if (!this.deps.store.claimEvent(`cron-claim:${job.id}:${stamp}`, `cron:${job.id}`)) continue;
      try {
        await this.deps.enqueue({
          eventId: `cron:${job.id}:${stamp}`,
          channel: "cron",
          threadKey: `cron:${job.id}:${stamp}`,
          chatId: sched.chatId,
          userId: sched.userId,
          text: job.prompt,
          repo: job.repo,
          isDirect: true,
        });
      } catch (e) {
        console.warn(`[pisa] 定时任务 ${job.id} 投递失败：${String(e).slice(0, 300)}`);
      }
    }
  }
}
