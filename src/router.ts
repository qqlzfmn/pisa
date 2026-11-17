import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Config, RepoConfig } from "./config";
import { githubRepos, parseCommand, repoByAlias, splitRepoAlias } from "./config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "./types";
import type { Store } from "./store";
import type { WorkerRunner } from "./worker";
import type { Deliverer } from "./deliver";
import { createWorktree, currentBranch, deleteBranch, isGitRepo, removeWorktree, sh } from "./git";
import { defaultRunner, formatReply, postComment, postIssueComment, type Runner } from "./github";
import { TaskLogger } from "./log";

export interface RouterDeps {
  cfg: Config;
  store: Store;
  worker: WorkerRunner;
  deliverer: Deliverer;
  channel: ChannelAdapter;
  /** 回帖用的 gh 执行器；默认走真实命令，测试注入假实现 */
  ghRunner?: Runner;
  /** 注入以便测试 */
  now?: () => number;
}

function newId(now = Date.now()): string {
  const d = new Date(now);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `t_${ymd}_${randomBytes(3).toString("hex")}`;
}

/** 毫秒 → 人类可读时长：不足 1 分钟给秒，不足 1 小时给 XmYs，其余 XhYm */
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

/** 需求单行预览：折叠换行与连续空白，超长截断并补省略号 */
function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const FINISHED_LABEL: Record<string, string> = { succeeded: "成功", failed: "失败", cancelled: "取消" };

export class Router {
  private active = new Map<string, Promise<void>>();
  /** 关停中：不再调度新任务；执行中的任务完成后保持 running，交由下次启动的 recoverInterrupted 分流 */
  private stopping = false;
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

  /**
   * 关停：只停止调度与等待，不改写任务状态、不清理工作副本。
   * 执行中的任务由 runTask 在 Worker 返回后看到 stopping 直接退出，任务留在 running，
   * 下次启动由 recoverInterrupted 转成 paused 等待请求者恢复。
   */
  async stop(timeoutMs = 3000): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    const cap = Promise.withResolvers<void>();
    const capTimer = setTimeout(cap.resolve, timeoutMs);
    await Promise.race([Promise.all([...this.active.values()]), cap.promise]);
    clearTimeout(capTimer);
  }

  /**
   * 进程重启后的分流：工作副本仍在且有会话 id 的 running 任务转 paused，
   * 其余 running 任务标 failed。工作副本一律保留，交给恢复者复用。
   */
  recoverInterrupted(): { paused: number; failed: number } {
    const { cfg, store } = this.deps;
    const result = { paused: 0, failed: 0 };
    for (const task of store.runningTasks()) {
      const workdir = resolve(cfg.stateDir, "worktrees", task.id);
      if (task.sessionId && existsSync(workdir)) {
        if (store.transition(task.id, "paused")) result.paused += 1;
      } else if (store.transition(task.id, "failed", { error: "进程重启，任务中断", endedAt: this.now() })) {
        result.failed += 1;
      }
    }
    return result;
  }

  /** 任务看板：运行中 / 排队 / 最近完成，末尾汇总 */
  private statusBoard(): string {
    const { store } = this.deps;
    const now = this.now();
    const running = store.runningTasks();
    const queued = store.queuedTasks();
    const finished = store.recentFinished(5);
    const counts = store.countByStatus();
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

    const lines = ["运行中"];
    if (running.length === 0) lines.push("(无)");
    for (const t of running) {
      const elapsed = formatDuration(now - (t.startedAt ?? t.createdAt));
      lines.push(`${t.id} · ${t.repo} · 已运行 ${elapsed} · ${preview(t.prompt, 40)}`);
    }

    lines.push("", `排队（${queued.length}）`);
    if (queued.length === 0) lines.push("(无)");
    for (const t of queued.slice(0, 5)) lines.push(`${t.id} · ${t.repo} · ${preview(t.prompt, 40)}`);

    lines.push("", "最近完成");
    if (finished.length === 0) lines.push("(无)");
    for (const t of finished) {
      const spent = formatDuration((t.endedAt ?? t.createdAt) - (t.startedAt ?? t.createdAt));
      const parts = [FINISHED_LABEL[t.status] ?? t.status, spent, t.repo, preview(t.prompt, 30)];
      if (t.prUrl) parts.push(t.prUrl);
      lines.push(parts.join(" · "));
    }

    lines.push("", `汇总：${total} 个任务 · 成功 ${counts.succeeded} · 失败 ${counts.failed} · 暂停 ${counts.paused}`);
    return lines.join("\n");
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
    if (this.stopping) return;
    const limit = Math.max(1, this.deps.cfg.worker.concurrency ?? 1);
    while (this.active.size < limit) {
      const task = this.deps.store.nextQueued();
      if (!task) break;
      const branch = task.branch ?? `pisa/${task.id}`;
      if (!this.deps.store.claimQueued(task.id, this.now(), branch)) break;
      this.launch({ ...task, branch, status: "running" });
    }
  }

  /**
   * `@别名 正文` 指定仓库；触发词形式先剥触发词再识别，命中后重组回触发词文本。
   * 别名不存在或没有正文时原样返回，仍走默认仓库。
   */
  private routeByAlias(msg: IncomingMessage): IncomingMessage {
    const { cfg } = this.deps;
    const lead = splitRepoAlias(msg.text, cfg.repos);
    if (lead) return { ...msg, repo: lead.alias, text: lead.body };

    const text = msg.text.trim();
    if (!text.startsWith(cfg.trigger)) return msg;
    const inner = splitRepoAlias(text.slice(cfg.trigger.length), cfg.repos);
    if (!inner) return msg;
    return { ...msg, repo: inner.alias, text: `${cfg.trigger} ${inner.body}` };
  }

  /** 处理一条入口消息；幂等、鉴权、建任务都在这里 */
  async handle(msg: IncomingMessage): Promise<void> {
    const { cfg, store, channel } = this.deps;

    msg = this.routeByAlias(msg);

    // 回复某条任务消息 = 对该任务续跑
    if (msg.replyToMessageId) {
      const parentId = store.taskByMessage(msg.chatId, String(msg.replyToMessageId));
      const text = msg.text.trim();
      if (parentId && !text.startsWith(cfg.trigger) && !text.startsWith("/")) {
        const parent = store.get(parentId);
        msg = { ...msg, repo: parent?.repo ?? msg.repo, text: `${cfg.trigger} continue ${parentId} ${text}` };
      }
    }

    let cmd = parseCommand(msg.text, cfg.trigger);

    // 专用 bot 的私聊：不需要触发词，直接说话就是任务
    if (!cmd && msg.isDirect && cfg.dmWithoutTrigger) {
      const t = msg.text.trim();
      if (t === "/start" || t === "/help" || t === "帮助") cmd = { kind: "help", body: "" };
      else if (t === "/status" || t === "状态") cmd = { kind: "status", body: "" };
      else if (t === "/schedules" || t === "定时") cmd = { kind: "schedules", body: "" };
      else if (t === "/cancel" || t.startsWith("/cancel ")) cmd = { kind: "cancel", body: t.slice(7).trim() };
      else if (t === "/resume" || t.startsWith("/resume ")) cmd = { kind: "resume", body: t.slice(7).trim() };
      else if (t && !t.startsWith("/")) cmd = { kind: "task", body: t };
    }
    if (!cmd) return;

    if (cmd.kind === "help") {
      await this.reply(
        msg.chatId,
        [
          "pisa · 命令",
          `${cfg.trigger} <需求>        接一个任务（私聊可直接说需求）`,
          `${cfg.trigger} @别名 <需求>   指定仓库（多仓库时用）`,
          `${cfg.trigger} cancel [任务号]  取消（私聊可用 /cancel）`,
          `${cfg.trigger} resume <任务号>  恢复被进程重启中断的任务`,
          `${cfg.trigger} continue <任务号> <新要求>  接着上一轮的分支做`,
          `${cfg.trigger} merge <任务号>     合并到主干（自举）`,
          `${cfg.trigger} schedules      查看定时任务（私聊可用 /schedules）`,
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

    if (cmd.kind === "schedules") {
      const jobs = cfg.schedules ?? [];
      if (jobs.length === 0) {
        await this.reply(
          msg.chatId,
          [
            "没有配置定时任务。",
            "在 pisa.config.json 里加 scheduler（发送方身份）与 schedules，重启后生效：",
            '{"scheduler":{"chatId":"<chat id>","userId":"<user id>"},"schedules":[{"id":"morning","cron":"0 9 * * 1-5","prompt":"检查 CI 失败并修复","repo":"pisa"}]}',
          ].join("\n"),
        );
        return;
      }
      const lines = jobs.map(
        (j) => `${j.id} · ${j.cron} · ${j.repo ?? "默认仓库"} · ${j.enabled === false ? "停用" : "启用"}`,
      );
      await this.reply(msg.chatId, `定时任务（${jobs.length}）\n${lines.join("\n")}`);
      return;
    }

    if (cmd.kind === "status") {
      await this.reply(msg.chatId, this.statusBoard());
      return;
    }

    let prompt = cmd.body;
    let baseRef: string | null = null;
    let context: string | null = null;
    /** PR 评论续跑：直接落在父任务的分支与原 PR 上 */
    let branch: string | null = null;
    let prUrl: string | null = null;

    // 续跑：命令式 `/pisa continue <任务号> <新要求>`，或 PR 评论直接指定父任务
    if (cmd.kind === "continue" || msg.continueFrom) {
      const words = cmd.kind === "continue" ? prompt.split(/\s+/) : [];
      const parentId = cmd.kind === "continue" ? (words[0] ?? "") : msg.continueFrom!;
      const parent = store.get(parentId);
      if (!parent) {
        await this.reply(msg.chatId, `找不到任务 ${parentId}`);
        return;
      }
      // IM 续跑只允许原请求者；PR 评论以配置身份投递，评论作者与 IM 用户无从对应
      if (cmd.kind === "continue" && parent.requester !== msg.userId) {
        await this.reply(msg.chatId, "只有原请求者可以续跑。");
        return;
      }
      if (!parent.branch) {
        await this.reply(msg.chatId, `任务 ${parent.id} 没有可续跑的分支。`);
        return;
      }
      baseRef = parent.branch;
      // 续跑必须落在父任务所在仓库：分支是仓库本地的
      msg = { ...msg, repo: parent.repo };
      if (msg.replyPr) {
        // 评论续跑必须更新原 PR：复用父任务分支，不留空让 fill() 新开 pisa/<新任务号>
        branch = parent.branch;
        prUrl = parent.prUrl;
      }
      const lines = [
        `任务号：${parent.id}`,
        `上一轮请求：${parent.prompt}`,
        `上一轮结果：${(parent.summary ?? "(无摘要)").slice(0, 1500)}`,
        `上一轮分支：${parent.branch}`,
      ];
      if (msg.replyPr) lines.push(`PR：#${msg.replyPr}`, `PR 评论：${msg.text.trim().slice(0, 1000)}`);
      context = lines.join("\n");
      prompt = (cmd.kind === "continue" ? words.slice(1).join(" ") : cmd.body).trim();
      if (!prompt) {
        await this.reply(msg.chatId, `用法：${cfg.trigger} continue <任务号> <新要求>`);
        return;
      }
    }

    const repo = repoByAlias(cfg, msg.repo ?? cfg.repos[0]?.alias);
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
      branch,
      prUrl,
      sessionId: null,
      baseRef,
      context,
      replyPr: msg.replyPr ?? null,
      replyIssue: msg.replyIssue ?? null,
      replyRepo: msg.replyRepo ?? null,
      summary: null,
      error: null,
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      cancelRequested: false,
    };
    store.insertTask(task);
    await this.reply(msg.chatId, `已接单 · ${task.id}\n仓库：${repo.alias}\n排队中。`);
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
      const mine = store.recentTasks(20).find(
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
    if (this.stopping) return false;
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

  /** 回帖到来源 PR / Issue；失败只记日志，不改任务状态 */
  private replyToSource(task: Task, summary: string, log: TaskLogger): void {
    const gh = this.deps.cfg.github;
    // 多仓库：任务记住评论所在仓库；旧任务与 IM 触发的回帖退回配置里的单仓库
    const repo = task.replyRepo ?? githubRepos(gh)[0]?.repo;
    if (!gh?.enabled || !repo) return;
    const runner = this.deps.ghRunner ?? defaultRunner;
    const body = formatReply(summary);
    if (task.replyPr) {
      const res = postComment(runner, repo, task.replyPr, body);
      log.write("reply-pr", res.ok ? `PR #${task.replyPr} 已回帖` : `PR #${task.replyPr} 回帖失败：${res.error.slice(0, 500)}`);
    }
    if (task.replyIssue) {
      const res = postIssueComment(runner, repo, task.replyIssue, body);
      log.write(
        "reply-issue",
        res.ok ? `Issue #${task.replyIssue} 已回帖` : `Issue #${task.replyIssue} 回帖失败：${res.error.slice(0, 500)}`,
      );
    }
  }

  /**
   * 失败/取消清理：只删任务自建的分支。
   * 续跑复用父任务分支时该分支是共享资产，删掉会毁掉上一轮成果与原 PR。
   */
  private cleanupBranch(repoPath: string, task: Task, branch: string): void {
    if (branch === `pisa/${task.id}`) deleteBranch(repoPath, branch);
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
        // 分支被占：git 拒绝把同一分支挂到两个工作副本；绝不另建同名分支顶替
        const occupied = /already checked out|already used by worktree/i.test(wt.err);
        const reason = occupied ? `分支 ${branch} 已被其它工作副本占用` : `创建工作副本失败（分支 ${branch}）`;
        const error = `${reason}：${wt.err || wt.out}`;
        log.write("worktree", error);
        store.transition(task.id, "failed", { error, endedAt: this.now() });
        await this.reply(task.chatId, `失败 · ${task.id}\n${error.slice(0, 800)}`);
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

    // 关停中：不写终态、不删工作副本与分支，任务留在 running 等下次启动分流为 paused
    if (this.stopping) {
      log.write("stopping", "进程关停，任务保持 running");
      return;
    }

    if (store.isCancelRequested(task.id) || result.error === "任务已取消") {
      removeWorktree(repo.path, workdir);
      this.cleanupBranch(repo.path, task, branch);
      store.transition(task.id, "cancelled", { endedAt: this.now() });
      await this.reply(task.chatId, `已取消 · ${task.id}`);
      return;
    }

    if (!result.ok) {
      log.write("failed", result.error ?? "");
      removeWorktree(repo.path, workdir);
      this.cleanupBranch(repo.path, task, branch);
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
      this.cleanupBranch(repo.path, task, branch);
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
    this.replyToSource(task, result.summary, log);

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
