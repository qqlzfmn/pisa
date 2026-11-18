import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config, WebConfig } from "./config";
import type { ReplyBus } from "./reply-bus";
import type { Store } from "./store";
import type { Effect, IncomingMessage, Task, TaskStatus } from "./types";
import type { RewindPlan } from "./rewind";
import { readTail, tailLines, TAIL_LINES } from "./log";
import { daemonState, taskJson, type DaemonState, type TaskJson } from "./status";
import { windowMetrics, type WindowMetrics } from "./metrics";

/** 页面与命令行共用的状态标签 */
const STATUS_LABEL: Record<string, string> = {
  queued: "排队",
  running: "运行中",
  paused: "已中断",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  rewound: "已撤销",
};

/** 对外投影：状态带中文标签，其余字段与 CLI 同源 */
export interface BoardTask extends TaskJson {
  statusLabel: string;
}

export function boardTask(task: Task, now = Date.now()): BoardTask {
  return { ...taskJson(task, now), statusLabel: STATUS_LABEL[task.status] ?? task.status };
}

export interface EffectJson {
  kind: string;
  target: string;
  detail: string | null;
  createdAt: number;
}

export interface StatePayload {
  ok: true;
  daemon: DaemonState;
  executor: { paused: boolean; running: number; queued: number; concurrency: number };
  counts: Record<TaskStatus, number>;
  total: number;
  running: BoardTask[];
  queued: BoardTask[];
  finished: BoardTask[];
  last24h: WindowMetrics;
}

export interface TicketPayload {
  task: BoardTask;
  effects: EffectJson[];
  logTail: string[];
}

/** 写操作的统一返回：status 直接作为 HTTP 状态码，body 原样作为响应 */
export interface ActionReply {
  status: number;
  body: Record<string, unknown> & { ok: boolean };
}

/** Manager 只依赖 Router 的这几个能力；Router 结构化满足它 */
export interface ManagerRouter {
  handle(msg: IncomingMessage): Promise<void>;
  planRewindFor(taskId: string, msg: IncomingMessage): { plan: RewindPlan } | { error: string; code: "notFound" | "notRunnable" | "forbidden" | "config" };
  activeCount(): number;
}

export interface ManagerDeps {
  cfg: Config;
  store: Store;
  router: ManagerRouter;
  bus: ReplyBus;
  web: WebConfig;
  now?: () => number;
}

const DENIED = /^(无权限|仓库未配置|仓库路径)/;

/**
 * 本机控制面的业务外壳：把 HTTP 动作翻译成一条 IM 消息交给 Router，
 * 再按 Router 的回执与库内状态判定成败。Web 控制台与管理接口共用它，
 * 因此白名单、状态机、合并与撤销校验只存在一份。
 */
export class Manager {
  readonly web: WebConfig;
  private readonly now: () => number;
  // 写操作串行：回执总线按 chatId 收集，并发派活会互相偷走回复；合并也需要独占仓库
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ManagerDeps) {
    this.web = deps.web;
    this.now = deps.now ?? Date.now;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 一次表单提交或接口调用就是一件事：线程与消息都绑在这次提交上 */
  message(kind: "task" | "cancel" | "merge" | "retry" | "rewind", body: string, repo?: string): IncomingMessage & { threadKey: string } {
    const eventId = `api:${randomUUID()}`;
    return {
      eventId,
      channel: this.web.chatId,
      chatId: this.web.chatId,
      userId: this.web.userId,
      text: `${this.deps.cfg.trigger} ${kind === "task" ? body : `${kind} ${body}`}`,
      repo,
      isDirect: true,
      admin: true,
      receivedAt: this.now(),
      threadKey: eventId,
    };
  }

  /** 执行一条消息，返回 Router 对它的回执 */
  async run(msg: IncomingMessage): Promise<{ message: string; ok: boolean }> {
    return this.serialize(async () => {
      const { bus, router } = this.deps;
      bus.take();
      await router.handle(msg);
      const lines = bus.take();
      return { message: lines.join("\n"), ok: lines.length > 0 && !lines.some((l) => DENIED.test(l)) };
    });
  }

  async dispatchTask(repo: string | undefined, prompt: string): Promise<{ taskId: string; message: string; ok: boolean }> {
    const msg = this.message("task", prompt, repo);
    const result = await this.run(msg);
    const task = this.bound(msg);
    return { taskId: task?.id ?? "", ...result, ok: result.ok && Boolean(task) };
  }

  async stop(id: string): Promise<ActionReply> {
    const { store } = this.deps;
    const before = store.get(id);
    if (!before) return { status: 404, body: { ok: false, message: `找不到任务 ${id}` } };
    const result = await this.run(this.message("cancel", id));
    const task = store.get(id);
    const done = Boolean(task && (task.status === "cancelled" || store.isCancelRequested(task.id)));
    return {
      status: done && result.ok ? 200 : 409,
      body: { ok: done && result.ok, status: task?.status ?? null, message: result.message },
    };
  }

  /** 只有失败或取消的任务可以重试；新任务号从触发记录反查，不猜 id */
  async retry(id: string): Promise<ActionReply> {
    const { store } = this.deps;
    const task = store.get(id);
    if (!task) return { status: 404, body: { ok: false, message: `找不到任务 ${id}` } };
    if (task.status !== "failed" && task.status !== "cancelled") {
      return { status: 409, body: { ok: false, status: task.status, message: `任务状态是 ${task.status}，只有失败或取消的任务可以重试` } };
    }
    const msg = this.message("retry", id);
    const result = await this.run(msg);
    const next = this.bound(msg);
    return {
      status: next ? 200 : 409,
      body: { ok: Boolean(next) && result.ok, taskId: next?.id ?? null, message: result.message },
    };
  }

  async merge(id: string): Promise<ActionReply> {
    const { store } = this.deps;
    if (!store.get(id)) return { status: 404, body: { ok: false, message: `找不到任务 ${id}` } };
    const result = await this.run(this.message("merge", id));
    const done = store.effectsOf(id).some((e) => e.kind === "merge");
    const task = store.get(id);
    return {
      status: result.ok && done ? 200 : 409,
      body: { ok: result.ok && done, status: task?.status ?? null, message: result.message },
    };
  }

  /** 预览走只读计划；apply 才执行，执行结果以库内状态为准 */
  async rewind(id: string, apply: boolean): Promise<ActionReply> {
    const planned = this.deps.router.planRewindFor(id, this.message("rewind", id));
    if ("error" in planned) {
      const status = { notFound: 404, forbidden: 403, notRunnable: 409, config: 400 }[planned.code];
      return { status, body: { ok: false, message: planned.error } };
    }
    if (!apply) return { status: 200, body: { ok: true, plan: planned.plan } };
    const result = await this.run(this.message("rewind", `${id} --yes`));
    const task = this.deps.store.get(id);
    const done = task?.status === "rewound";
    return {
      status: result.ok && done ? 200 : 409,
      body: { ok: result.ok && done, status: task?.status ?? null, message: result.message },
    };
  }

  /** 暂停只停补位，运行中的任务照常收尾；开关落库，重启后仍然有效 */
  setPaused(paused: boolean): ActionReply {
    const { store, router, cfg } = this.deps;
    store.setExecutorPaused(paused);
    return {
      status: 200,
      body: {
        ok: true,
        executor: {
          paused: store.executorPaused(),
          running: router.activeCount(),
          queued: store.countByStatus().queued,
          concurrency: Math.max(1, cfg.worker.concurrency ?? 1),
        },
      },
    };
  }

  state(): StatePayload {
    const { store, router, cfg } = this.deps;
    const at = this.now();
    const running = store.runningTasks();
    const queued = store.queuedTasks();
    const finished = store.recentFinished(20);
    const counts = store.countByStatus();
    return {
      ok: true,
      daemon: daemonState(store, at),
      executor: {
        paused: store.executorPaused(),
        running: router.activeCount(),
        queued: counts.queued,
        concurrency: Math.max(1, cfg.worker.concurrency ?? 1),
      },
      counts,
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      running: running.map((t) => boardTask(t, at)),
      queued: queued.map((t) => boardTask(t, at)),
      finished: finished.map((t) => boardTask(t, at)),
      last24h: windowMetrics(store, at),
    };
  }

  ticket(id: string): TicketPayload | null {
    const { store, cfg } = this.deps;
    const task = store.get(id);
    if (!task) return null;
    return {
      task: boardTask(task, this.now()),
      effects: store.effectsOf(id).map((e: Effect) => ({ kind: e.kind, target: e.target, detail: e.detail, createdAt: e.createdAt })),
      logTail: tailLog(cfg, id),
    };
  }

  private bound(msg: { threadKey: string; eventId: string }): Task | null {
    const bind = this.deps.store.triggerByMessage(msg.threadKey, msg.eventId);
    return bind?.taskId ? this.deps.store.get(bind.taskId) : null;
  }
}

/** 日志尾部：Web 面板与 `pisa logs` 看到同一份文本 */
export function tailLog(cfg: Config, id: string, limit = TAIL_LINES): string[] {
  const path = join(cfg.stateDir, "logs", `${id}.log`);
  if (!existsSync(path)) return [];
  return tailLines(readTail(path), limit).map((line) => {
    try {
      const rec = JSON.parse(line) as { ts?: number; stage?: string; msg?: string };
      const time = typeof rec.ts === "number" ? new Date(rec.ts).toTimeString().slice(0, 8) : "-";
      return `${time} ${rec.stage ?? "-"} ${rec.msg ?? ""}`.trimEnd();
    } catch {
      return line;
    }
  });
}
