import { randomUUID } from "node:crypto";
import type { Config, WebConfig } from "./config";
import type { Store } from "./store";
import type { IncomingMessage } from "./types";
import type { AuditAction, AuditLog } from "./audit";
import { redact } from "./log";
import { HttpError } from "./http";

/** 回执收集器：Web 用 ReplyBus，测试可换成任意实现 */
export interface ReplySink {
  take(chatId?: string): string[];
}

/** 本模块只需要 Router 的消息入口；撤销与合并由调用方单独注入 */
export interface MessageRouter {
  handle(msg: IncomingMessage): Promise<void>;
}

export interface WebSessionDeps {
  cfg: Config;
  web: WebConfig;
  store: Store;
  router: MessageRouter;
  bus: ReplySink;
  audit: AuditLog;
}

export interface SessionOutcome {
  message: string;
  ok: boolean;
}

/**
 * Web 写操作的公共外壳：把 HTTP 动作翻译成一条 Router 消息、串行执行、收回执并落审计。
 * 校验（白名单、状态机、仓库）全部由 Router 负责，这里不复制。
 */
export class WebSession {
  // 写操作串行：回执总线按 chatId 收集，并发派活会互相偷走回复；合并也需要独占仓库
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: WebSessionDeps) {}

  /** 写操作留痕；detail 里不放完整任务正文，先脱敏再截断 */
  record(action: AuditAction, target: string, ok: boolean, detail: string | null = null): void {
    this.deps.audit.append({ actor: this.deps.web.userId, action, target, ok, detail });
  }

  serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 把表单动作翻译成一条 IM 消息：一次提交就是一件事，线程与消息都绑在它上面 */
  message(body: string, repo?: string): IncomingMessage & { threadKey: string } {
    const { cfg, web } = this.deps;
    const eventId = `web:${randomUUID()}`;
    return {
      eventId,
      channel: "web",
      chatId: web.chatId,
      userId: web.userId,
      text: `${cfg.trigger} ${body}`,
      repo,
      isDirect: true,
      admin: true,
      receivedAt: Date.now(),
      threadKey: `web:${eventId}`,
    };
  }

  /** 执行一条消息，返回 Router 对它的回执 */
  async run(msg: IncomingMessage & { threadKey: string }): Promise<SessionOutcome> {
    return this.serialize(async () => {
      this.deps.bus.take();
      await this.deps.router.handle(msg);
      const lines = this.deps.bus.take();
      return {
        message: lines.join("\n"),
        ok: lines.length > 0 && !lines.some((l) => /^(无权限|仓库未配置|仓库路径)/.test(l)),
      };
    });
  }

  /** 新建任务；返回 Router 为这次提交绑定的任务号 */
  async dispatchTask(repo: string | undefined, prompt: string): Promise<SessionOutcome & { taskId: string }> {
    const msg = this.message(prompt, repo);
    const result = await this.run(msg);
    const task = this.boundTask(msg);
    return { taskId: task?.id ?? "", ...result, ok: result.ok && Boolean(task) };
  }

  /**
   * 重试：为终态任务再排一次。有分支的走 continue 语义（复用分支与上下文），
   * 没有分支的按原需求重新排队；其余状态给出明确出路。
   */
  async retry(id: string): Promise<SessionOutcome & { taskId: string }> {
    const task = this.deps.store.get(id);
    if (!task) throw new HttpError(404, `找不到任务 ${id}`);
    if (task.status === "queued" || task.status === "running") {
      throw new HttpError(409, `任务仍在进行（${task.status}），不能重试`);
    }
    if (task.status === "paused") throw new HttpError(409, `任务已暂停，请用 resume ${task.id} 继续`);
    if (task.status === "succeeded") {
      throw new HttpError(409, `任务已成功：用 merge ${task.id} 合入或 rewind ${task.id} 撤销`);
    }
    const msg = this.message(task.branch ? `continue ${task.id} ${task.prompt}` : task.prompt, task.repo);
    const result = await this.run(msg);
    const created = this.boundTask(msg);
    return { taskId: created?.id ?? "", ...result, ok: result.ok && Boolean(created) };
  }

  /** 提交后 Router 为该消息建的任务 */
  private boundTask(msg: IncomingMessage & { threadKey: string }) {
    const bound = this.deps.store.triggerByMessage(msg.threadKey, msg.eventId);
    return bound?.taskId ? this.deps.store.get(bound.taskId) : null;
  }

  /** 派活审计用的正文预览 */
  previewPrompt(prompt: string): string {
    return redact(prompt).slice(0, 120);
  }
}
