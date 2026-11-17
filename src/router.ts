import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Config, RepoConfig } from "./config";
import { parseCommand, repoByAlias } from "./config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "./types";
import type { Store } from "./store";
import type { WorkerRunner } from "./worker";
import type { Deliverer } from "./deliver";
import { createWorktree, currentBranch, deleteBranch, isGitRepo, removeWorktree, sh } from "./git";
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

  /**
   * 进程重启后的分流：工作副本仍在且有会话 id 的 running 任务转 paused，
   * 其余 running 任务标 failed。工作副本一律保留，交给恢复者复用。
   */
  recoverInterrupted(): { paused: number; failed: number } {
    const { cfg, store } = this.deps;
    const result = { paused: 0, failed: 0 };
    for (const task of store.listRunning()) {
      const workdir = resolve(cfg.stateDir, "worktrees", task.id);
      if (task.sessionId && existsSync(workdir)) {
        if (store.transition(task.id, "paused")) result.paused += 1;
      } else if (store.transition(task.id, "failed", { error: "进程重启，任务中断", endedAt: this.now() })) {
        result.failed += 1;
      }
    }
    return result;
  }

  /** 立即执行一个已进入 running 的任务；不等待完成 */
  private launch(task: Task): void {
    const branch = task.branch ?? `pisa/${task.id}`;
    const p = this.runTask(task, branch)
      .catch(() => {})
      .finally(() => this.active.delete(task.id));
    this.active.set(task.id, p);
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
      this.launch({ ...task, branch, status: "running" });
    }
  }

  /** 处理一条入口消息；幂等、鉴权、建任务都在这里 */
  async handle(msg: IncomingMessage): Promise<void> {
    const { cfg, store, channel } = this.deps;

    // 回复某条任务消息 = 对该任务续跑
    if (msg.replyToMessageId) {
      const parentId = store.taskByMessage(msg.chatId, String(msg.replyToMessageId));
      const text = msg.text.trim();
      if (parentId && !text.startsWith(cfg.trigger) && !text.startsWith("/")) {
        msg = { ...msg, text: `${cfg.trigger} continue ${parentId} ${text}` };
      }
    }

    let cmd = parseCommand(msg.text, cfg.trigger);

    // 专用 bot 的私聊：不需要触发词，直接说话就是任务
    if (!cmd && msg.isDirect && cfg.dmWithoutTrigger) {
      const t = msg.text.trim();
      if (t === "/start" || t === "/help" || t === "帮助") cmd = { kind: "help", body: "" };
      else if (t === "/status" || t === "状态") cmd = { kind: "status", body: "" };
      else if (t === "/cancel" || t.startsWith("/cancel ")) cmd = { kind: "cancel", body: t.slice(7).trim() };
      else if (t === "/resume" || t.startsWith("/resume ")) cmd = { kind: "resume", body: t.slice(7).trim() };
      else if (t && !t.startsWith("/")) cmd = { kind: "task", body: t };
    }
    if (!cmd) return;

    const repo = repoByAlias(cfg, msg.repo ?? cfg.repos[0]?.alias);

    if (cmd.kind === "help") {
      await this.reply(
        msg.chatId,
        [
          "pisa · 命令",
          `${cfg.trigger} <需求>        接一个任务（私聊可直接说需求）`,
          `${cfg.trigger} cancel [任务号]  取消（私聊可用 /cancel）`,
          `${cfg.trigger} resume <任务号>  恢复被进程重启中断的任务`,
          `${cfg.trigger} continue <任务号> <新要求>  接着上一轮的分支做`,
          `${cfg.trigger} merge <任务号>     合并到主干（自举）`,
          `${cfg.trigger} help           本帮助（私聊可用 /help）`,
        ].join("\n"),
      );
      return;
    }

    if (cmd.kind === "cancel") {
      await this.handleCancel(msg, cmd.body);
      return;
    }

    if (cmd.kind === "resume") {
      await this.handleResume(msg, cmd.body);
      return;
    }

    if (cmd.kind === "merge") {
      await this.handleMerge(msg, cmd.body);
      return;
    }

    if (cmd.kind === "status") {
      const rows = store.recent(5);
      if (rows.length === 0) {
        await this.reply(msg.chatId, "还没有任务。");
        return;
      }
      const text = rows
        .map((t) => {
          const time = new Date(t.createdAt).toLocaleString("zh-CN", { hour12: false });
          return `${t.id} · ${t.status}${t.branch ? " · " + t.branch : ""} · ${time}`;
        })
        .join("\n");
      await this.reply(msg.chatId, `最近 ${rows.length} 个任务\n${text}`);
      return;
    }

    let prompt = cmd.body;
    let baseRef: string | null = null;
    let context: string | null = null;

    if (cmd.kind === "continue") {
      const [parentId, ...rest] = prompt.split(/\s+/);
      const parent = parentId ? store.get(parentId) : null;
      if (!parent) {
        await this.reply(msg.chatId, `找不到任务 ${parentId ?? ""}`);
        return;
      }
      if (parent.requester !== msg.userId) {
        await this.reply(msg.chatId, "只有原请求者可以续跑。");
        return;
      }
      if (!parent.branch) {
        await this.reply(msg.chatId, `任务 ${parent.id} 没有可续跑的分支。`);
        return;
      }
      baseRef = parent.branch;
      context = [
        `任务号：${parent.id}`,
        `上一轮请求：${parent.prompt}`,
        `上一轮结果：${(parent.summary ?? "(无摘要)").slice(0, 1500)}`,
        `上一轮分支：${parent.branch ?? "-"}`,
      ].join("\n");
      prompt = rest.join(" ").trim();
      if (!prompt) {
        await this.reply(msg.chatId, `用法：${cfg.trigger} continue <任务号> <新要求>`);
        return;
      }
    }

    const taskId = newId(this.now());
    // 去重：同一事件只登记一次；重复投递直接丢弃
    if (!store.claimEvent(msg.eventId, taskId)) return;

    const denied = this.checkAccess(msg, repo);
    if (denied) {
      const last = this.deniedAt.get(msg.userId) ?? 0;
      if (this.now() - last > 24 * 3600 * 1000) {
        this.deniedAt.set(msg.userId, this.now());
        await this.reply(msg.chatId, denied);
      }
      return;
    }
    if (!repo) {
      await this.reply(msg.chatId, `仓库未配置：${msg.repo ?? "(默认)"}`);
      return;
    }
    if (!prompt) {
      await this.reply(msg.chatId, `用法：${cfg.trigger} <需求描述>`);
      return;
    }

    const task: Task = {
      id: taskId,
      source: msg.eventId,
      channel: msg.channel,
      chatId: msg.chatId,
      requester: msg.userId,
      repo: repo.alias,
      prompt,
      status: "queued",
      branch: null,
      prUrl: null,
      sessionId: null,
      baseRef,
      context,
      summary: null,
      error: null,
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      cancelRequested: false,
    };
    store.insertTask(task);
    await this.reply(msg.chatId, `已接单 · ${task.id}\n仓库 ${repo.alias}，排队中。`);
  }

  /** 统一发送；带 taskId 时记住消息 id，之后用户回复这条消息即可续跑 */
  private async reply(chatId: string, text: string, taskId?: string): Promise<void> {
    const receipt = await this.deps.channel.send(chatId, text);
    if (taskId && receipt && "messageId" in receipt && receipt.messageId) {
      this.deps.store.linkMessage(chatId, receipt.messageId, taskId);
    }
  }

  private checkAccess(msg: IncomingMessage, repo: RepoConfig | undefined): string | null {
    const { cfg } = this.deps;
    if (!cfg.whitelist.users.includes(msg.userId)) return "无权限：该用户不在白名单。";
    if (!repo) return `仓库未配置：${msg.repo ?? "(默认)"}`;
    if (!cfg.whitelist.repos.includes(repo.alias)) return `无权限：仓库 ${repo.alias} 不在白名单。`;
    if (!isGitRepo(repo.path)) return `仓库路径不是 git 仓库：${repo.path}`;
    return null;
  }

  /** 自举：把已完成任务的分支验证后合入主干 */
  private async handleMerge(msg: IncomingMessage, body: string): Promise<void> {
    const { cfg, store, channel } = this.deps;
    const id = body.trim();
    const task = id ? store.get(id) : null;
    if (!task) {
      await this.reply(msg.chatId, `找不到任务 ${id || ""}`);
      return;
    }
    if (task.requester !== msg.userId) {
      await this.reply(msg.chatId, "只有原请求者可以合并。");
      return;
    }
    if (task.status !== "succeeded" || !task.branch) {
      await this.reply(msg.chatId, `任务 ${task.id} 没有可合并的分支（${task.status}）。`);
      return;
    }
    const repo = repoByAlias(cfg, task.repo);
    if (!repo) {
      await this.reply(msg.chatId, `仓库未配置：${task.repo}`);
      return;
    }

    const verifyBranch = `verify/${task.id}`;
    const verifyDir = resolve(cfg.stateDir, "verify", task.id);
    const wt = createWorktree(repo.path, verifyDir, verifyBranch, task.branch);
    if (wt.code !== 0) {
      await this.reply(msg.chatId, `验证副本创建失败：${wt.err.slice(0, 300)}`);
      return;
    }

    let ok = true;
    let detail = "没有测试目录，跳过测试";
    try {
      const hasTests = existsSync(join(verifyDir, "tests")) || existsSync(join(verifyDir, "test"));
      if (hasTests) {
        const test = sh(["bun", "test"], verifyDir);
        ok = test.code === 0;
        detail = ok ? "测试通过" : `测试失败：\n${(test.err || test.out).slice(-600)}`;
      }
    } finally {
      removeWorktree(repo.path, verifyDir);
      deleteBranch(repo.path, verifyBranch);
    }

    if (!ok) {
      await this.reply(msg.chatId, `未合并 · ${task.id}\n${detail}`);
      return;
    }

    const base = repo.baseBranch ?? "main";
    if (currentBranch(repo.path) !== base) {
      await this.reply(msg.chatId, `主工作区当前不在 ${base}，请先切回再合并。`);
      return;
    }
    const merge = sh(["git", "-C", repo.path, "merge", "--ff-only", task.branch]);
    if (merge.code !== 0) {
      await this.reply(msg.chatId, `合并失败：${(merge.err || merge.out).slice(0, 600)}`);
      return;
    }

    await this.reply(msg.chatId, `已合并 · ${task.id}\n${detail}\n分支 ${task.branch} → ${base}`);

    // 自举：由看护进程拉起新代码
    if (process.env.PISA_SUPERVISED === "1") {
      setTimeout(() => process.exit(1), 800);
    } else {
      await this.reply(msg.chatId, "当前不是看护模式，改动在重启后生效。");
    }
  }

  private async handleCancel(msg: IncomingMessage, body: string): Promise<void> {
    const { store, channel } = this.deps;
    let id = body.trim();
    if (!id) {
      const mine = store.recent(20).find(
        (t) =>
          t.chatId === msg.chatId && (t.status === "running" || t.status === "queued" || t.status === "paused"),
      );
      if (!mine) {
        await this.reply(msg.chatId, "没有可取消的任务。");
        return;
      }
      id = mine.id;
    }
    const task = store.get(id);
    if (!task) {
      await this.reply(msg.chatId, `找不到任务 ${id}`);
      return;
    }
    if (task.requester !== msg.userId) {
      await this.reply(msg.chatId, "只有原请求者可以取消。");
      return;
    }
    if (task.status === "queued" || task.status === "paused") {
      store.transition(id, "cancelled", { endedAt: this.now() });
      await this.reply(msg.chatId, `已取消 · ${id}`);
      return;
    }
    if (task.status !== "running") {
      await this.reply(msg.chatId, `任务 ${id} 已结束（${task.status}）`);
      return;
    }
    store.requestCancel(id);
    await this.reply(msg.chatId, `取消中 · ${id}`);
  }

  /** 恢复被进程重启中断的任务：复用原工作副本与会话再次执行 */
  private async handleResume(msg: IncomingMessage, body: string): Promise<void> {
    const { cfg, store } = this.deps;
    const id = body.trim();
    const task = id ? store.get(id) : null;
    if (!task) {
      await this.reply(msg.chatId, `找不到任务 ${id || ""}`);
      return;
    }
    if (task.requester !== msg.userId) {
      await this.reply(msg.chatId, "只有原请求者可以恢复。");
      return;
    }
    if (task.status !== "paused") {
      await this.reply(msg.chatId, `任务 ${id} 不是中断状态（${task.status}），只有中断的任务可以恢复。`);
      return;
    }
    if (!existsSync(resolve(cfg.stateDir, "worktrees", id))) {
      await this.reply(msg.chatId, `任务 ${id} 的工作副本已不存在，无法恢复。`);
      return;
    }
    const limit = Math.max(1, cfg.worker.concurrency ?? 1);
    if (this.active.size >= limit) {
      await this.reply(msg.chatId, `当前并发已满（${limit}），稍后再恢复 ${id}。`);
      return;
    }

    const startedAt = this.now();
    if (!store.transition(id, "running", { startedAt, error: null })) {
      await this.reply(msg.chatId, `恢复失败 · ${id}`);
      return;
    }
    await this.reply(msg.chatId, `恢复执行 · ${id}\n分支 ${task.branch ?? `pisa/${id}`}`, id);
    this.launch({ ...task, status: "running", startedAt });
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

  /** 轮询 pi 扩展写出的进度文件，节流后转发到对话 */
  private watchProgress(task: Task): () => void {
    const file = join(resolve(this.deps.cfg.stateDir), "progress", `${task.id}.jsonl`);
    let size = 0;
    let lastSentAt = 0;
    let lastMsg = "";

    const push = (text: string) => {
      const now = Date.now();
      if (text === lastMsg || now - lastSentAt < 6000) return;
      lastMsg = text;
      lastSentAt = now;
      void this.reply(task.chatId, text, task.id);
    };

    const timer = setInterval(() => {
      let chunk = "";
      try {
        const buf = readFileSync(file, "utf8");
        if (buf.length <= size) return;
        chunk = buf.slice(size);
        size = buf.length;
      } catch {
        return;
      }
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        let o: Record<string, any>;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (o.type === "session" && o.sessionId) this.deps.store.setSessionId(task.id, String(o.sessionId));
        if (o.type === "blocked") push(`⛔ 拦下一条命令：${String(o.detail ?? "").slice(0, 120)}`);
        if (o.type !== "tool") continue;
        const tool = String(o.tool ?? "");
        const detail = String(o.detail ?? "").slice(0, 120);
        if (tool === "bash") push(`🛠 ${detail}`);
        else if (/edit|write|patch|create/i.test(tool)) push(`✏️ ${tool}${detail ? " " + detail : ""}`);
      }
    }, 2000);

    return () => clearInterval(timer);
  }

  private async runTask(task: Task, branch: string): Promise<void> {
    const { cfg, store, channel, worker, deliverer } = this.deps;
    const repo = repoByAlias(cfg, task.repo);
    if (!repo) {
      store.transition(task.id, "failed", { error: `仓库未配置：${task.repo}`, endedAt: this.now() });
      await this.reply(task.chatId, `失败 · ${task.id}：仓库未配置`);
      return;
    }

    // 占位已在 fill() 完成；这里只做执行
    // 必须是绝对路径：omp 的 --cwd 按相对路径解析会二次拼接
    const workdir = resolve(cfg.stateDir, "worktrees", task.id);
    const log = new TaskLogger(cfg.stateDir, task.id);
    // 恢复中断任务：工作副本已存在，直接在其上继续，不重建也不重置分支
    const resuming = existsSync(workdir);
    log.write("start", `${repo.alias} ${branch}`);

    if (resuming) {
      log.write("resume", "复用已有工作副本");
    } else {
      const wt = createWorktree(repo.path, workdir, branch, task.baseRef ?? repo.baseBranch ?? "HEAD");
      if (wt.code !== 0) {
        log.write("worktree", wt.err);
        store.transition(task.id, "failed", { error: `创建工作副本失败：${wt.err}`, endedAt: this.now() });
        await this.reply(task.chatId, `失败 · ${task.id}\n创建工作副本失败`);
        return;
      }
    }

    await this.reply(task.chatId, `开始执行 · ${task.id}\n分支 ${branch}`, task.id);

    const stopWatch = this.watchProgress(task);
    let result: WorkerResult;
    try {
      result = await worker.run(
        task,
        workdir,
        (line) => log.write("worker", line),
        () => store.isCancelRequested(task.id),
        resuming,
      );
    } catch (err) {
      result = { ok: false, summary: "", error: (err as Error).message, exitCode: -1 };
    } finally {
      stopWatch();
    }

    if (store.isCancelRequested(task.id) || result.error === "任务已取消") {
      removeWorktree(repo.path, workdir);
      deleteBranch(repo.path, branch);
      store.transition(task.id, "cancelled", { endedAt: this.now() });
      await this.reply(task.chatId, `已取消 · ${task.id}`);
      return;
    }

    if (!result.ok) {
      log.write("failed", result.error ?? "");
      removeWorktree(repo.path, workdir);
      deleteBranch(repo.path, branch);
      store.transition(task.id, "failed", { error: result.error ?? "未知错误", endedAt: this.now() });
      await this.reply(task.chatId, `失败 · ${task.id}\n${(result.error ?? "").slice(0, 800)}`, task.id);
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
      await this.reply(task.chatId, `失败 · ${task.id}\n${(err as Error).message.slice(0, 800)}`);
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

    const fresh = store.get(task.id);
    const lines = [`✅ ${task.id} 完成`, result.summary.slice(0, 1200)];
    if (delivery.files.length) lines.push(`改动 ${delivery.files.length} 个文件：${delivery.files.slice(0, 8).join(", ")}`);
    else lines.push("没有代码改动。");
    if (delivery.branch) lines.push(`分支：${delivery.branch}`);
    if (delivery.prUrl) lines.push(`链接：${delivery.prUrl}`);
    if (fresh?.sessionId) lines.push(`会话：${fresh.sessionId.slice(0, 8)}`);
    await this.reply(task.chatId, lines.join("\n\n"), task.id);
  }
}
