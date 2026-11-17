import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Config, RepoConfig } from "./config";
import { parseCommand, repoByAlias } from "./config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "./types";
import type { Store } from "./store";
import type { WorkerRunner } from "./worker";
import type { Deliverer } from "./deliver";
import { createWorktree, deleteBranch, isGitRepo, removeWorktree } from "./git";
import { TaskLogger } from "./log";

export interface RouterDeps {
  cfg: Config;
  store: Store;
  worker: WorkerRunner;
  deliverer: Deliverer;
  channel: ChannelAdapter;
  /** 注入以便测试 */
  now?: () => number;
}

function newId(now = Date.now()): string {
  const d = new Date(now);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `t_${ymd}_${randomBytes(3).toString("hex")}`;
}

export class Router {
  private active = new Map<string, Promise<void>>();
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  /** 拒绝提示节流：同一用户 24h 只提示一次 */
  private deniedAt = new Map<string, number>();

  constructor(private deps: RouterDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(intervalMs = 800): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.fill(), intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.race([
      Promise.all([...this.active.values()]),
      new Promise((r) => setTimeout(r, 10_000)),
    ]);
  }

  /** 按并发上限补位；不等待任务完成 */
  private async fill(): Promise<void> {
    if (this.stopped) return;
    const limit = Math.max(1, this.deps.cfg.worker.concurrency ?? 1);
    while (this.active.size < limit) {
      const task = this.deps.store.nextQueued();
      if (!task) break;
      const branch = `pisa/${task.id}`;
      if (!this.deps.store.claimQueued(task.id, this.now(), branch)) break;
      const p = this.runTask(task, branch)
        .catch(() => {})
        .finally(() => this.active.delete(task.id));
      this.active.set(task.id, p);
    }
  }

  /** 处理一条入口消息；幂等、鉴权、建任务都在这里 */
  async handle(msg: IncomingMessage): Promise<void> {
    const { cfg, store, channel } = this.deps;
    const cmd = parseCommand(msg.text, cfg.trigger);
    if (!cmd) return;

    const repo = repoByAlias(cfg, msg.repo ?? cfg.repos[0]?.alias);

    if (cmd.kind === "help") {
      await channel.send(
        msg.chatId,
        [
          "pisa · 命令",
          `${cfg.trigger} <需求>        接一个任务`,
          `${cfg.trigger} cancel [任务号]  取消`,
          `${cfg.trigger} help           本帮助`,
        ].join("\n"),
      );
      return;
    }

    if (cmd.kind === "cancel") {
      await this.handleCancel(msg, cmd.body);
      return;
    }

    if (cmd.kind === "status") {
      const rows = store.recent(5);
      if (rows.length === 0) {
        await channel.send(msg.chatId, "还没有任务。");
        return;
      }
      const text = rows
        .map((t) => {
          const time = new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false });
          return `${t.id} · ${t.status}${t.branch ? " · " + t.branch : ""} · ${time}`;
        })
        .join("\n");
      await channel.send(msg.chatId, `最近 ${rows.length} 个任务\n${text}`);
      return;
    }

    const taskId = newId(this.now());
    // 去重：同一事件只登记一次；重复投递直接丢弃
    if (!store.claimEvent(msg.eventId, taskId)) return;

    const denied = this.checkAccess(msg, repo);
    if (denied) {
      const last = this.deniedAt.get(msg.userId) ?? 0;
      if (this.now() - last > 24 * 3600 * 1000) {
        this.deniedAt.set(msg.userId, this.now());
        await channel.send(msg.chatId, denied);
      }
      return;
    }
    if (!repo) {
      await channel.send(msg.chatId, `仓库未配置：${msg.repo ?? "(默认)"}`);
      return;
    }
    if (!cmd.body) {
      await channel.send(msg.chatId, `用法：${cfg.trigger} <需求描述>`);
      return;
    }

    const task: Task = {
      id: taskId,
      source: msg.eventId,
      channel: msg.channel,
      chatId: msg.chatId,
      requester: msg.userId,
      repo: repo.alias,
      prompt: cmd.body,
      status: "queued",
      branch: null,
      prUrl: null,
      summary: null,
      error: null,
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      cancelRequested: false,
    };
    store.insertTask(task);
    await channel.send(msg.chatId, `已接单 · ${task.id}\n仓库 ${repo.alias}，排队中。`);
  }

  private checkAccess(msg: IncomingMessage, repo: RepoConfig | undefined): string | null {
    const { cfg } = this.deps;
    if (!cfg.whitelist.users.includes(msg.userId)) return "无权限：该用户不在白名单。";
    if (!repo) return `仓库未配置：${msg.repo ?? "(默认)"}`;
    if (!cfg.whitelist.repos.includes(repo.alias)) return `无权限：仓库 ${repo.alias} 不在白名单。`;
    if (!isGitRepo(repo.path)) return `仓库路径不是 git 仓库：${repo.path}`;
    return null;
  }

  private async handleCancel(msg: IncomingMessage, body: string): Promise<void> {
    const { store, channel } = this.deps;
    let id = body.trim();
    if (!id) {
      const mine = store.recent(20).find((t) => t.chatId === msg.chatId && (t.status === "running" || t.status === "queued"));
      if (!mine) {
        await channel.send(msg.chatId, "没有可取消的任务。");
        return;
      }
      id = mine.id;
    }
    const task = store.get(id);
    if (!task) {
      await channel.send(msg.chatId, `找不到任务 ${id}`);
      return;
    }
    if (task.requester !== msg.userId) {
      await channel.send(msg.chatId, "只有原请求者可以取消。");
      return;
    }
    if (task.status === "queued") {
      store.transition(id, "cancelled", { endedAt: this.now() });
      await channel.send(msg.chatId, `已取消 · ${id}`);
      return;
    }
    if (task.status !== "running") {
      await channel.send(msg.chatId, `任务 ${id} 已结束（${task.status}）`);
      return;
    }
    store.requestCancel(id);
    await channel.send(msg.chatId, `取消中 · ${id}`);
  }

  /** 取一个排队任务执行；返回是否真的执行了 */
  async drainOnce(): Promise<boolean> {
    if (this.stopped) return false;
    let started = false;
    while (true) {
      await this.fill();
      if (this.active.size === 0) break;
      started = true;
      await Promise.all([...this.active.values()]);
      if (!this.deps.store.nextQueued()) break;
    }
    return started;
  }

  private async runTask(task: Task, branch: string): Promise<void> {
    const { cfg, store, channel, worker, deliverer } = this.deps;
    const repo = repoByAlias(cfg, task.repo);
    if (!repo) {
      store.transition(task.id, "failed", { error: `仓库未配置：${task.repo}`, endedAt: this.now() });
      await channel.send(task.chatId, `失败 · ${task.id}：仓库未配置`);
      return;
    }

    // 占位已在 fill() 完成；这里只做执行
    const workdir = join(cfg.stateDir, "worktrees", task.id);
    const log = new TaskLogger(cfg.stateDir, task.id);
    log.write("start", `${repo.alias} ${branch}`);

    const wt = createWorktree(repo.path, workdir, branch, repo.baseBranch ?? "HEAD");
    if (wt.code !== 0) {
      log.write("worktree", wt.err);
      store.transition(task.id, "failed", { error: `创建工作副本失败：${wt.err}`, endedAt: this.now() });
      await channel.send(task.chatId, `失败 · ${task.id}\n创建工作副本失败`);
      return;
    }

    await channel.send(task.chatId, `开始执行 · ${task.id}\n分支 ${branch}`);

    let result: WorkerResult;
    try {
      result = await worker.run(task, workdir, (line) => log.write("worker", line), () =>
        store.isCancelRequested(task.id),
      );
    } catch (err) {
      result = { ok: false, summary: "", error: (err as Error).message, exitCode: -1 };
    }

    if (store.isCancelRequested(task.id) || result.error === "任务已取消") {
      removeWorktree(repo.path, workdir);
      deleteBranch(repo.path, branch);
      store.transition(task.id, "cancelled", { endedAt: this.now() });
      await channel.send(task.chatId, `已取消 · ${task.id}`);
      return;
    }

    if (!result.ok) {
      log.write("failed", result.error ?? "");
      removeWorktree(repo.path, workdir);
      deleteBranch(repo.path, branch);
      store.transition(task.id, "failed", { error: result.error ?? "未知错误", endedAt: this.now() });
      await channel.send(task.chatId, `失败 · ${task.id}\n${(result.error ?? "").slice(0, 800)}`);
      return;
    }

    let delivery;
    try {
      delivery = await deliverer.deliver({ ...task, branch }, workdir, repo);
    } catch (err) {
      log.write("deliver", (err as Error).message);
      removeWorktree(repo.path, workdir);
      deleteBranch(repo.path, branch);
      store.transition(task.id, "failed", { error: (err as Error).message, endedAt: this.now() });
      await channel.send(task.chatId, `失败 · ${task.id}\n${(err as Error).message.slice(0, 800)}`);
      return;
    }

    store.transition(task.id, "succeeded", {
      summary: result.summary,
      branch: delivery.branch ?? branch,
      prUrl: delivery.prUrl ?? null,
      endedAt: this.now(),
    });
    removeWorktree(repo.path, workdir);
    log.write("done", `files=${delivery.files.length} pushed=${delivery.pushed}`);

    const lines = [`✅ ${task.id} 完成`, result.summary.slice(0, 1200)];
    if (delivery.files.length) lines.push(`改动 ${delivery.files.length} 个文件：${delivery.files.slice(0, 8).join(", ")}`);
    else lines.push("没有代码改动。");
    if (delivery.branch) lines.push(`分支：${delivery.branch}`);
    if (delivery.prUrl) lines.push(`链接：${delivery.prUrl}`);
    await channel.send(task.chatId, lines.join("\n\n"));
  }
}
