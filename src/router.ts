import { join, resolve, sep } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { CommandKind, Config, RepoConfig } from "./config";
import { githubRepos, parseCommand, repoByAlias, splitRepoAlias, taskGuard } from "./config";
import type { ChannelAdapter, IncomingMessage, Task, WorkerResult } from "./types";
import type { EffectRow, Store } from "./store";
import type { WorkerRunner } from "./worker";
import type { Deliverer } from "./deliver";
import { EffectQueue, type CommentPayload, type PrPayload, type PushPayload } from "./effects";
import { createWorktree, currentBranch, deleteBranch, isGitRepo, listWorktrees, localBranches, remoteBranches, remoteUrl, removeWorktree, sh } from "./git";
import {
  defaultRunner,
  formatReply,
  githubRepoSlug,
  listOpenPrs,
  postComment,
  postIssueComment,
  postReplyOnce,
  prNumberFromIssueUrl,
  prStatus,
  type Runner,
} from "./github";
import { applyRewind, formatRewindPlan, formatRewindResult, planRewind, type RewindProbes } from "./rewind";
import {
  applyReconcile,
  formatReconcile,
  planReconcile,
  realPath,
  type RepoReality,
  type WorktreeReality,
} from "./reconcile";
import { formatExamples, formatHelp } from "./usage";
import { TaskLogger } from "./log";
import { newTaskId } from "./ids";
import { makeTrigger, threadKeyOf } from "./trigger";
import { continuationContext } from "./task-context";
import { formatStatusBoard } from "./status";
import { decide, formatPolicy } from "./policy";

export { formatDuration } from "./status";

export interface RouterDeps {
  cfg: Config;
  store: Store;
  worker: WorkerRunner;
  deliverer: Deliverer;
  channel: ChannelAdapter;
  /** 回帖用的 gh 执行器；默认走真实命令，测试注入假实现 */
  ghRunner?: Runner;
  /** 外部动作的 outbox；默认由 Router 按 store 创建，测试可注入以观察队列 */
  effects?: EffectQueue;
  /** 注入以便测试 */
  now?: () => number;
}

/**
 * 是否点名机器人：入口显式给出优先；缺省按「不是群聊即点名」推断，
 * 私聊与 webhook/cron/web 这类显式调用都是直接找机器人。
 */
function mentionedOf(msg: IncomingMessage): boolean {
  return msg.mentioned ?? msg.isDirect !== false;
}

/** 单英文词任务的待确认正文，10 分钟过期 */
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingTask {
  prompt: string;
  repo?: string;
  at: number;
}

export class Router {
  private active = new Map<string, Promise<void>>();
  /** 关停中：不再调度新任务；执行中的任务完成后保持 running，交由下次启动的 recoverInterrupted 分流 */
  private stopping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 上次孤儿任务巡检时间 */
  private lastReconcile = 0;
  /** 过程消息开关：默认关，只发生命周期消息 */
  private progressOn: boolean;
  private readonly now: () => number;
  /** 拒绝提示节流：同一用户 24h 只提示一次 */
  private deniedAt = new Map<string, number>();
  /** 被拦下的单英文词任务：键 `${chatId}:${userId}`，每人只保留一条 */
  private pending = new Map<string, PendingTask>();
  /** 外部动作的 outbox：推送、建 PR、回帖都先落库再执行 */
  private readonly effects: EffectQueue;

  constructor(private deps: RouterDeps) {
    this.now = deps.now ?? Date.now;
    this.progressOn = deps.cfg.notifications?.progress ?? false;
    this.effects = deps.effects ?? new EffectQueue(deps.store, { now: this.now });
    this.registerEffects(deps.deliverer);
  }

  /** 注册外部动作；成功时顺手记账本，重启后的重放走同一条路径 */
  private registerEffects(deliverer: Deliverer): void {
    const handlers = deliverer.effectHandlers();
    this.effects
      .register("push", async (p) => {
        await handlers.push(p);
        this.deps.store.effect(p.taskId, "push", "origin", p.branch);
        return null;
      })
      .register("pr", async (p) => {
        const res = await handlers.pr(p);
        this.bookPr(p.taskId, p.repo, res.url);
        return res;
      })
      .register("comment", (p) => this.commentEffect(p));
  }

  /** 交付拿到 PR 链接：账本记 PR 并回填 pr_url；effect 与无改动时认领的路径共用 */
  private bookPr(taskId: string, repoAlias: string, url: string | null): void {
    const n = url ? prNumberFromIssueUrl(url) : null;
    if (!url || !n) return;
    this.deps.store.effect(taskId, "pr", String(n), repoAlias);
    this.deps.store.setPrUrl(taskId, url);
  }

  /** 回帖 effect：线程里已有同标记就是发过了，重试不会重复 */
  private commentEffect(p: CommentPayload): Promise<"posted" | "skipped"> {
    const res = postReplyOnce(this.deps.ghRunner ?? defaultRunner, p.repo, p.number, p.purpose, p.taskId, p.body);
    if (!res.ok) return Promise.reject(new Error(res.error));
    if (res.value === "posted") {
      const kind = p.purpose === "pr" ? "PR" : "Issue";
      this.deps.store.effect(p.taskId, "comment", `${p.repo}#${p.number}`, `${kind} 回帖`);
    }
    return Promise.resolve(res.value);
  }

  start(intervalMs = 800): void {
    if (this.timer) return;
    this.deps.store.beat();
    this.effects.start();
    this.timer = setInterval(() => {
      this.deps.store.beat();
      if (this.now() - this.lastReconcile > 5000) {
        this.lastReconcile = this.now();
        this.reconcileOrphans();
      }
      void this.fill();
    }, intervalMs);
  }

  /**
   * 关停：只停止调度与等待，不改写任务状态、不清理工作副本。
   * 执行中的任务由 runTask 在 Worker 返回后看到 stopping 直接退出，任务留在 running，
   * 下次启动由 recoverInterrupted 转成 paused 等待请求者恢复。
   */
  async stop(timeoutMs = 3000): Promise<void> {
    this.stopping = true;
    this.effects.stop();
    clearInterval(this.timer ?? undefined);
    this.timer = null;
    const cap = Promise.withResolvers<void>();
    const capTimer = setTimeout(cap.resolve, timeoutMs);
    await Promise.race([Promise.all([...this.active.values()]), cap.promise]);
    clearTimeout(capTimer);
  }

  /**
   * 进程重启后的分流：已请求取消的 running 任务转 cancelled（取消是对写操作的否决，
   * 不得因重启变成可 resume 的 paused）；工作副本仍在且有会话 id 的转 paused；
   * 其余标 failed。工作副本一律保留。
   */
  recoverInterrupted(): { paused: number; failed: number; cancelled: number } {
    const { cfg, store } = this.deps;
    const result = { paused: 0, failed: 0, cancelled: 0 };
    for (const task of store.runningTasks()) {
      if (task.cancelRequested) {
        if (store.transition(task.id, "cancelled", { endedAt: this.now() })) {
          this.effects.cancelTask(task.id);
          result.cancelled += 1;
        }
        continue;
      }
      const workdir = resolve(cfg.stateDir, "worktrees", task.id);
      if (task.sessionId && existsSync(workdir)) {
        if (store.transition(task.id, "paused")) result.paused += 1;
      } else if (store.transition(task.id, "failed", { error: "进程重启，任务中断", endedAt: this.now() })) {
        this.effects.cancelTask(task.id);
        result.failed += 1;
      }
    }
    return result;
  }

  /**
   * 运行期兜底：DB 里是 running 但本进程没有执行器的行（上一次进程崩溃/被 kill 的遗留），
   * 按 worktree + sessionId 分流为 paused / failed，避免永久卡在 running。
   * 只处理启动超过 30 秒的任务，避开 claimQueued 到 launch 之间的瞬间。
   */
  reconcileOrphans(): number {
    const { cfg, store } = this.deps;
    const cutoff = this.now() - 30_000;
    let n = 0;
    for (const task of store.runningTasks()) {
      if (this.active.has(task.id)) continue;
      if (task.startedAt !== null && task.startedAt > cutoff) continue;
      const workdir = resolve(cfg.stateDir, "worktrees", task.id);
      if (task.sessionId && existsSync(workdir)) {
        if (store.transition(task.id, "paused", { error: "执行器丢失，任务暂停" })) n += 1;
      } else if (store.transition(task.id, "failed", { error: "执行器丢失，任务中断", endedAt: this.now() })) {
        this.effects.cancelTask(task.id);
        n += 1;
      }
    }
    return n;
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
    const replyTaskId = msg.replyToMessageId ? store.taskByMessage(msg.chatId, String(msg.replyToMessageId)) : null;
    if (replyTaskId) {
      const text = msg.text.trim();
      if (!text.startsWith(cfg.trigger) && !text.startsWith("/")) {
        const parent = store.get(replyTaskId);
        msg = { ...msg, repo: parent?.repo ?? msg.repo, text: `${cfg.trigger} continue ${replyTaskId} ${text}` };
      }
    }
    // 线程解析前置：后续建任务与去重都按这条线程算
    const threadKey = threadKeyOf(msg, replyTaskId);
    msg = { ...msg, threadKey };

    let cmd = parseCommand(msg.text, cfg.trigger);

    // 专用 bot 的私聊：不需要触发词，直接说话就是任务
    if (!cmd && msg.isDirect && cfg.dmWithoutTrigger) {
      const t = msg.text.trim();
      if (t === "/start" || t === "/help" || t === "帮助") cmd = { kind: "help", body: "" };
      else if (t === "/status" || t === "状态") cmd = { kind: "status", body: "" };
      else if (t === "/schedules" || t === "定时") cmd = { kind: "schedules", body: "" };
      else if (t === "/examples" || t === "示例") cmd = { kind: "examples", body: "" };
      else if (t === "/policy" || t === "策略") cmd = { kind: "policy", body: "" };
      else if (t === "/confirm") cmd = { kind: "confirm", body: "" };
      else if (t === "/cancel" || t.startsWith("/cancel ")) cmd = { kind: "cancel", body: t.slice(7).trim() };
      else if (t === "/resume" || t.startsWith("/resume ")) cmd = { kind: "resume", body: t.slice(7).trim() };
      else if (t === "/rewind" || t.startsWith("/rewind ")) cmd = { kind: "rewind", body: t.slice(7).trim() };
      else if (t === "/reconcile" || t.startsWith("/reconcile "))
        cmd = { kind: "reconcile", body: t.slice(10).trim() };
      else if (t && !t.startsWith("/")) cmd = { kind: "task", body: t };
      else if (t.startsWith("/")) {
        // 未知斜杠命令：只对可能是命令错拼的单词给提示，其余保持忽略
        const guard = taskGuard(t.slice(1));
        if (guard?.kind === "suggest") {
          await this.reply(msg.chatId, this.suggestText(msg, guard.command, t.slice(1)));
          return;
        }
      }
    }
    if (!cmd) {
      // 同线程的后续消息（没有命令）：并进该线程未结束任务的上下文，不新建任务
      const open = store.openTaskByThread(threadKey);
      const text = msg.text.trim();
      if (open && text) {
        const trigger = makeTrigger({
          source: msg.channel,
          threadKey,
          messageKey: msg.messageKey ?? msg.eventId,
          actor: msg.actor ?? msg.userId,
          at: msg.receivedAt ?? this.now(),
          text,
          version: msg.version,
        });
        store.attachThreadNote(trigger, open.id, `补充说明：${text}`);
      }
      return;
    }

    // 除确认以外的下一条命令视为放弃待确认；避免旧单词被迟到的 confirm 建单
    if (cmd.kind !== "confirm") this.pending.delete(this.pendingKey(msg));

    // 待确认的单英文词任务：确认后跳过防护，直接建任务
    let fromConfirm = false;
    if (cmd.kind === "confirm") {
      const pending = this.takePending(msg);
      if (!pending) {
        await this.reply(msg.chatId, `没有待确认的任务。直接发 ${cfg.trigger} <需求> 接单。`);
        return;
      }
      cmd = { kind: "task", body: pending.prompt };
      if (pending.repo) msg = { ...msg, repo: pending.repo };
      fromConfirm = true;
    }

    // 命令误触防护：打错命令只给建议；其余单英文词先要求确认，不落库
    // admin 入口（web）是明确的表单提交，没有可回 confirm 的聊天，直接放行
    if (cmd.kind === "task" && !fromConfirm && !msg.admin) {
      const guard = taskGuard(cmd.body);
      if (guard?.kind === "suggest") {
        await this.reply(msg.chatId, this.suggestText(msg, guard.command, cmd.body.trim()));
        return;
      }
      if (guard?.kind === "confirm") {
        this.pending.set(this.pendingKey(msg), { prompt: cmd.body.trim(), repo: msg.repo, at: this.now() });
        await this.reply(
          msg.chatId,
          `「${cmd.body.trim()}」只有一个英文单词，确认要把它当成任务吗？\n回复 ${cfg.trigger} confirm 确认（10 分钟内有效，其它命令视为放弃）。`,
        );
        return;
      }
    }

    if (cmd.kind === "help") {
      await this.reply(msg.chatId, formatHelp(cfg.trigger));
      return;
    }

    if (cmd.kind === "examples") {
      await this.reply(msg.chatId, formatExamples(cfg.trigger));
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

    if (cmd.kind === "rewind") {
      await this.handleRewind(msg, cmd.body);
      return;
    }

    if (cmd.kind === "verbose") {
      const v = cmd.body.trim().toLowerCase();
      if (v === "on" || v === "开") this.progressOn = true;
      else if (v === "off" || v === "关") this.progressOn = false;
      await this.reply(
        msg.chatId,
        `过程消息：${this.progressOn ? "开（执行细节会逐条推送）" : "关（只发接单/执行/完成）"}`,
      );
      return;
    }

    if (cmd.kind === "gc") {
      await this.handleGc(msg, cmd.body);
      return;
    }

    if (cmd.kind === "reconcile") {
      await this.handleReconcile(msg, cmd.body);
      return;
    }

    if (cmd.kind === "policy") {
      await this.reply(msg.chatId, formatPolicy(cfg));
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
      await this.reply(msg.chatId, formatStatusBoard(this.deps.store, this.now()));
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
      if (!msg.admin && cmd.kind === "continue" && parent.requester !== msg.userId) {
        await this.reply(msg.chatId, "只有原请求者可以续跑。");
        return;
      }
      // PR 评论续跑复用父任务分支：父任务没结束时另建任务，要么从 base 新开一条工作线、
      // 完成后多出一个 PR，要么在共享分支上撞工作副本。事件先占位并提示一次，重复投递静默。
      if (
        msg.replyPr &&
        (parent.status === "queued" || parent.status === "running" || parent.status === "paused")
      ) {
        if (store.claimEvent(msg.eventId, parent.id)) {
          await this.reply(
            msg.chatId,
            `PR #${msg.replyPr} 的任务 ${parent.id} 正在进行（${parent.status}），结束后再发评论。`,
          );
        }
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
      context = continuationContext(parent, msg.replyPr ? { number: msg.replyPr, text: msg.text.trim() } : undefined);
      prompt = (cmd.kind === "continue" ? words.slice(1).join(" ") : cmd.body).trim();
      if (!prompt) {
        await this.reply(msg.chatId, `用法：${cfg.trigger} continue <任务号> <新要求>`);
        return;
      }
    }

    const repo = repoByAlias(cfg, msg.repo ?? cfg.repos[0]?.alias);

    // 准入先于仓库校验：谁能派活由来源策略决定，仓库白名单只决定落在哪
    const mandate = decide(
      cfg,
      { source: msg.channel, principal: msg.userId, mentioned: mentionedOf(msg) },
      this.now(),
    );
    if (mandate.mode === "observe") {
      // 观察态只记录不派活；事件占位让重复投递不再重复提示
      if (store.claimEvent(msg.eventId, "observe")) await this.reply(msg.chatId, mandate.reason);
      return;
    }
    const denied = mandate.mode === "off" ? mandate.reason : this.checkAccess(msg, repo);
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

    // 触发身份只看「线程 + 消息 + 版本 + 载荷」：重复投递与编辑都命中同一条
    const at = msg.receivedAt ?? this.now();
    const trigger = makeTrigger({
      source: msg.channel,
      threadKey,
      messageKey: msg.messageKey ?? msg.eventId,
      actor: msg.actor ?? msg.userId,
      at,
      text: prompt,
      version: msg.version,
    });
    const task: Task = {
      id: newTaskId(this.now()),
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
      mandate,
      createdAt: this.now(),
      startedAt: null,
      endedAt: null,
      cancelRequested: false,
    };
    // 事件账本：占位排在鉴权与正文校验之后、任务落库之前，被拒的投递不能占住 eventId。
    // 去重由 triggers 决定，这里不按返回值拦截：同一 eventId 的编辑要能继续进入触发器路径。
    store.claimEvent(msg.eventId, task.id);
    const claim = store.createTaskFromTrigger(trigger, task);
    if (!claim.created) {
      if (claim.promptUpdated) await this.reply(msg.chatId, `任务 ${claim.taskId} 还没开跑，已按最新版本更新需求。`);
      else if (claim.edited) await this.reply(msg.chatId, `任务 ${claim.taskId} 已在执行，这次修改只做了留痕。`);
      return;
    }
    await this.reply(msg.chatId, `已接单 · ${task.id}\n仓库：${repo.alias}\n排队中。`);
  }

  /** 待确认任务按人与会话隔离，避免群里互相确认别人的任务 */
  private pendingKey(msg: IncomingMessage): string {
    return `${msg.chatId}:${msg.userId}`;
  }

  /** 取走待确认正文；过期的直接丢弃 */
  private takePending(msg: IncomingMessage): PendingTask | null {
    const key = this.pendingKey(msg);
    const pending = this.pending.get(key);
    if (!pending) return null;
    this.pending.delete(key);
    return this.now() - pending.at <= PENDING_TTL_MS ? pending : null;
  }

  /** 建议命令的写法：私聊用裸斜杠命令，群聊必须带触发词 */
  private commandHint(msg: IncomingMessage, command: CommandKind): string {
    const { cfg } = this.deps;
    return msg.isDirect && cfg.dmWithoutTrigger ? `/${command}` : `${cfg.trigger} ${command}`;
  }

  private suggestText(msg: IncomingMessage, command: CommandKind, word: string): string {
    return (
      `${word} 不是已知命令。\n` +
      `你要用的是：${this.commandHint(msg, command)}\n` +
      `如果确实要接任务，把需求写完整（例如 ${this.deps.cfg.trigger} 修复登录超时）。`
    );
  }

  /** 统一发送；带 taskId 时记住消息 id，之后用户回复这条消息即可续跑 */
  private async reply(chatId: string, text: string, taskId?: string): Promise<void> {
    // 通知失败不能影响任务本身：Telegram 429/网络抖动时只记日志
    let receipt: { messageId?: string } | void;
    try {
      receipt = await this.deps.channel.send(chatId, text);
    } catch (err) {
      console.error(`[pisa] 回复失败：${String(err).slice(0, 200)}`);
      return;
    }
    if (taskId && receipt && "messageId" in receipt && receipt.messageId) {
      this.deps.store.linkMessage(chatId, receipt.messageId, taskId);
    }
  }

  /** 合并后清理：工作副本、本地分支、远端分支都不再需要；代码已在主干，回退走 rewind 账本 */
  private cleanupMerged(repo: RepoConfig, task: Task): void {
    try {
      removeWorktree(repo.path, resolve(this.deps.cfg.stateDir, "worktrees", task.id));
      if (!task.branch) return;
      deleteBranch(repo.path, task.branch);
      if (repo.remote) sh(["git", "-C", repo.path, "push", "origin", "--delete", task.branch]);
    } catch (err) {
      console.error(`[pisa] 清理合并分支失败：${String(err).slice(0, 200)}`);
    }
  }

  /**
   * 清理已结束任务的残留：工作副本、本地/远端分支、未关闭的 PR。
   * 只处理结束时间早于 cutoff 的任务；dry-run 只统计不动手。
   */
  private async handleGc(msg: IncomingMessage, body: string): Promise<void> {
    const dry = /--dry|预览/.test(body);
    const days = Math.max(0, Number(body.replace(/--dry|预览/g, "").trim() || 7));
    const r = await this.gc(days, dry);
    await this.reply(
      msg.chatId,
      [
        `${dry ? "可清理" : "已清理"}（结束超过 ${days} 天的任务 ${r.tasks} 个）`,
        `工作副本 ${r.worktrees} · 本地分支 ${r.localBranches} · 远端分支 ${r.remoteBranches} · PR ${r.prs}`,
      ].join("\n"),
    );
  }

  /** 供命令与定时任务共用的清理入口 */
  async gc(days = 7, dry = false): Promise<{ tasks: number; worktrees: number; localBranches: number; remoteBranches: number; prs: number }> {
    const { cfg, store } = this.deps;
    const cutoff = this.now() - days * 86_400_000;
    const tasks = store.terminalTasksBefore(cutoff, 300);
    const out = { tasks: tasks.length, worktrees: 0, localBranches: 0, remoteBranches: 0, prs: 0 };
    for (const t of tasks) {
      const repo = repoByAlias(cfg, t.repo) ?? cfg.repos[0];
      if (!repo) continue;
      const dir = resolve(cfg.stateDir, "worktrees", t.id);
      if (existsSync(dir)) {
        if (!dry) removeWorktree(repo.path, dir);
        out.worktrees += 1;
      }
      if (t.branch && t.branch !== "main") {
        const exists = sh(["git", "-C", repo.path, "rev-parse", "--verify", t.branch]).code === 0;
        if (exists) {
          if (!dry) deleteBranch(repo.path, t.branch);
          out.localBranches += 1;
        }
        if (repo.remote) {
          if (!dry) sh(["git", "-C", repo.path, "push", "origin", "--delete", t.branch]);
          out.remoteBranches += 1;
        }
      }
      if (t.prUrl) {
        const n = prNumberFromIssueUrl(t.prUrl);
        if (n) {
          if (!dry) sh(["gh", "pr", "close", String(n)]);
          out.prs += 1;
        }
      }
    }
    if (!dry && cfg.repos[0]) sh(["git", "-C", cfg.repos[0].path, "worktree", "prune"]);
    return out;
  }

  /**
   * `/pisa reconcile [任务号] [--fix]`：任务记录与实际资源逐项比对并列出差异。
   * 只清理已结束任务的残留和没有任务记录的资源；运行中、成功待合并的一律保留。
   */
  private async handleReconcile(msg: IncomingMessage, body: string): Promise<void> {
    const { cfg, store } = this.deps;
    const fix = /--fix/.test(body);
    const scope = body.replace(/--fix/g, "").trim().split(/\s+/).filter(Boolean)[0] ?? null;
    const worktreeRoot = resolve(cfg.stateDir, "worktrees");
    const { repos, worktrees } = this.reconcileRealities(worktreeRoot);
    const tasks = store.allTasks();
    const findings = planReconcile({ tasks, repos, worktrees, worktreeRoot, scope });

    const outcomes = fix
      ? applyReconcile(findings, { runner: this.deps.ghRunner ?? defaultRunner, worktreeRoot })
      : null;

    const report = {
      scope,
      scopeRecorded: scope ? tasks.some((t) => t.id === scope) : false,
      findings,
      outcomes,
      tasks: tasks.length,
      repos: repos.length,
    };
    await this.reply(msg.chatId, formatReconcile(report, cfg.trigger));
  }

  /** 实际状态探测：只读分支、工作副本、PR，不做任何修改 */
  private reconcileRealities(worktreeRoot: string): { repos: RepoReality[]; worktrees: WorktreeReality[] } {
    const { cfg } = this.deps;
    const runner = this.deps.ghRunner ?? defaultRunner;
    const repos: RepoReality[] = [];
    const worktrees: WorktreeReality[] = [];
    const registered = new Set<string>();
    const root = realPath(worktreeRoot);

    for (const repo of cfg.repos) {
      const slug = githubRepoSlug(repo.remote ?? remoteUrl(repo.path));
      for (const w of listWorktrees(repo.path)) {
        const path = resolve(w.path);
        if (!realPath(path).startsWith(`${root}${sep}`)) continue;
        registered.add(realPath(path));
        worktrees.push({ path, repo: repo.alias, repoPath: repo.path, branch: w.branch });
      }
      repos.push({
        alias: repo.alias,
        repoPath: repo.path,
        slug,
        baseBranch: repo.baseBranch ?? "main",
        localBranches: localBranches(repo.path),
        remoteBranches: remoteBranches(repo.path),
        openPrs: slug ? listOpenPrs(runner, slug) : null,
      });
    }

    // 工作副本根目录下 git 没登记的目录：手工删过、prune 过之后留下的空壳
    if (existsSync(worktreeRoot)) {
      for (const entry of readdirSync(worktreeRoot, { withFileTypes: true })) {
        const path = resolve(worktreeRoot, entry.name);
        if (!entry.isDirectory() || registered.has(realPath(path))) continue;
        worktrees.push({ path, repo: null, repoPath: null, branch: null });
      }
    }
    return { repos, worktrees };
  }

  /** 仓库侧的准入：谁能派活已经由来源策略判定，这里只看落在哪 */
  private checkAccess(msg: IncomingMessage, repo: RepoConfig | undefined): string | null {
    const { cfg } = this.deps;
    if (!repo) return `仓库未配置：${msg.repo ?? "(默认)"}`;
    if (!cfg.whitelist.repos.includes(repo.alias)) return `无权限：仓库 ${repo.alias} 不在白名单。`;
    if (!isGitRepo(repo.path)) return `仓库路径不是 git 仓库：${repo.path}`;
    return null;
  }

  /** 自举：把已完成任务的分支验证后合入主干 */
  private async handleMerge(msg: IncomingMessage, body: string): Promise<void> {
    const { cfg, store, channel } = this.deps;
    const force = /(^|\s)--force\s*$/.test(body);
    const id = body.replace(/(^|\s)--force\s*$/, "").trim();
    const task = id ? store.get(id) : null;
    if (!task) {
      await this.reply(msg.chatId, `找不到任务 ${id || ""}`);
      return;
    }
    if (!msg.admin && task.requester !== msg.userId) {
      await this.reply(msg.chatId, "只有原请求者可以合并。");
      return;
    }
    // 合并会重启服务；有任务在跑时先拒绝，避免把 worker 打断成 paused
    if (!force && this.active.size > 0) {
      await this.reply(
        msg.chatId,
        `还有 ${this.active.size} 个任务在执行，合并会重启服务并打断它们。等结束后再合并，或加 --force。`,
      );
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
    const base = repo.baseBranch ?? "main";
    const wt = createWorktree(repo.path, verifyDir, verifyBranch, task.branch);
    if (wt.code !== 0) {
      await this.reply(msg.chatId, `验证副本创建失败：${wt.err.slice(0, 300)}`);
      return;
    }

    try {
      // 主干在任务执行期间可能已前进；先 rebase 到最新主干，否则 --ff-only 必然失败
      // CI 上没有全局 git 身份，rebase 必须显式带上提交者
      const rebase = sh([
        "git",
        "-C",
        verifyDir,
        "-c",
        `user.name=${this.deps.cfg.delivery.commitName}`,
        "-c",
        `user.email=${this.deps.cfg.delivery.commitEmail}`,
        "rebase",
        base,
      ]);
      if (rebase.code !== 0) {
        sh(["git", "-C", verifyDir, "rebase", "--abort"]);
        await this.reply(
          msg.chatId,
          `未合并 · ${task.id}\n分支与 ${base} 冲突，需要在最新主干重做：\n${(rebase.err || rebase.out).slice(0, 500)}`,
        );
        return;
      }

      let ok = true;
      let detail = "没有测试目录，跳过测试";
      const hasTests = existsSync(join(verifyDir, "tests")) || existsSync(join(verifyDir, "test"));
      if (hasTests) {
        const test = sh(["bun", "test"], verifyDir);
        ok = test.code === 0;
        detail = ok ? "测试通过" : `测试失败：\n${(test.err || test.out).slice(-600)}`;
      }
      if (!ok) {
        await this.reply(msg.chatId, `未合并 · ${task.id}\n${detail}`);
        return;
      }

      if (currentBranch(repo.path) !== base) {
        await this.reply(msg.chatId, `主工作区当前不在 ${base}，请先切回再合并。`);
        return;
      }
      const before = sh(["git", "-C", repo.path, "rev-parse", base]).out;
      // rebase 后 verify 分支已包含最新主干，可以安全快进
      const merge = sh(["git", "-C", repo.path, "merge", "--ff-only", verifyBranch]);
      if (merge.code !== 0) {
        await this.reply(msg.chatId, `合并失败：${(merge.err || merge.out).slice(0, 600)}`);
        return;
      }
      const after = sh(["git", "-C", repo.path, "rev-parse", base]).out;
      store.effect(task.id, "merge", base, JSON.stringify({ base, from: before, to: after }));

      // 本地合并必须回到远端，否则 GitHub 上看不到任何进展
      if (repo.remote) {
        const push = sh(["git", "-C", repo.path, "push", "origin", base]);
        if (push.code !== 0) {
          await this.reply(msg.chatId, `已本地合并，但推送 ${base} 失败：${(push.err || push.out).slice(0, 400)}`);
        }
      }

      // PR 不再承担合并入口：代码已在主干，关闭对应 PR 并说明
      if (task.prUrl) {
        const pr = prNumberFromIssueUrl(task.prUrl);
        if (pr) {
          sh(
            ["gh", "pr", "close", String(pr), "--comment", `已合并到 ${base}（pisa 本地 rebase 合并，分支保留备查）`],
            repo.path,
          );
        }
      }

      await this.reply(msg.chatId, `已合并 · ${task.id}\n${detail}\n分支 ${task.branch} → ${base}（分支与工作副本已清理）`);
      this.cleanupMerged(repo, task);
    } finally {
      removeWorktree(repo.path, verifyDir);
      deleteBranch(repo.path, verifyBranch);
    }

    // 自举：由看护进程拉起新代码
    if (process.env.PISA_SUPERVISED === "1") {
      setTimeout(() => process.exit(1), 800);
    } else {
      await this.reply(msg.chatId, "当前不是看护模式，改动在重启后生效。");
    }
  }

  /** 探测点：预览与执行都只读这些状态 */
  private rewindProbes(runner: Runner): RewindProbes {
    return {
      branchExists: (repoPath, branch) =>
        sh(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0,
      worktreeExists: (path) => existsSync(path),
      prState: (repo, n) => prStatus(runner, repo, n),
    };
  }

  /**
   * `/pisa rewind <任务号> [--yes]`：先给预览，带 --yes 才执行。
   * 已合并的任务用 revert 提交回退；无法确认 PR 状态时不动分支，避免误删已合并成果。
   */
  private async handleRewind(msg: IncomingMessage, body: string): Promise<void> {
    const { cfg, store } = this.deps;
    const words = body.split(/\s+/).filter(Boolean);
    const yes = words.includes("--yes");
    const id = words.find((w) => !w.startsWith("--")) ?? "";
    if (!id) {
      await this.reply(msg.chatId, `用法：${cfg.trigger} rewind <任务号> [--yes]`);
      return;
    }
    const task = store.get(id);
    if (!task) {
      await this.reply(msg.chatId, `找不到任务 ${id}`);
      return;
    }
    if (!msg.admin && task.requester !== msg.userId) {
      await this.reply(msg.chatId, "只有原请求者可以撤销。");
      return;
    }
    if (task.status === "rewound") {
      await this.reply(msg.chatId, `任务 ${id} 已撤销。`);
      return;
    }
    if (task.status === "queued" || task.status === "running" || task.status === "paused") {
      await this.reply(msg.chatId, `任务 ${id} 还没结束（${task.status}），先 ${cfg.trigger} cancel ${id}。`);
      return;
    }
    const repo = repoByAlias(cfg, task.repo);
    if (!repo) {
      await this.reply(msg.chatId, `仓库未配置：${task.repo}`);
      return;
    }

    const runner = this.deps.ghRunner ?? defaultRunner;
    const plan = planRewind(task, store.effectsOf(id), {
      repoPath: repo.path,
      baseBranch: repo.baseBranch ?? "main",
      probes: this.rewindProbes(runner),
    });
    if (!yes) {
      await this.reply(msg.chatId, formatRewindPlan(plan, cfg.trigger));
      return;
    }

    if (plan.actions.length === 0) {
      if (plan.merge !== "unknown") store.transition(id, "rewound");
      const lines = [plan.merge === "unknown" ? `未完成撤销 · ${id}` : `已标记撤销 · ${id}`, "没有需要执行的撤销动作。"];
      if (plan.irreversible.length > 0) lines.push("", "不可撤销", ...plan.irreversible.map((s) => `- ${s}`));
      if (plan.notes.length > 0) lines.push("", "保留", ...plan.notes.map((s) => `- ${s}`));
      await this.reply(msg.chatId, lines.join("\n"));
      return;
    }

    const results = applyRewind(plan, {
      taskId: id,
      runner,
      commitName: cfg.delivery.commitName,
      commitEmail: cfg.delivery.commitEmail,
    });
    // 成功的副作用已不存在，从账本删掉；失败的保留以便重试
    for (const r of results) {
      if (r.ok && r.effect) store.removeEffect(id, r.effect.kind, r.effect.target);
    }
    if (plan.merge !== "unknown" && results.every((r) => r.ok)) store.transition(id, "rewound");
    await this.reply(msg.chatId, formatRewindResult(plan, results));
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
    if (!msg.admin && task.requester !== msg.userId) {
      await this.reply(msg.chatId, "只有原请求者可以取消。");
      return;
    }
    if (task.status === "queued" || task.status === "paused") {
      this.effects.cancelTask(id);
      store.transition(id, "cancelled", { endedAt: this.now() });
      await this.reply(msg.chatId, `已取消 · ${id}`);
      return;
    }
    if (task.status !== "running") {
      await this.reply(msg.chatId, `任务 ${id} 已结束（${task.status}）`);
      return;
    }
    if (!this.active.has(id)) {
      // 进程重启后遗留的 running 行没有执行器，requestCancel 对它无效
      this.effects.cancelTask(id);
      store.transition(id, "cancelled", { endedAt: this.now() });
      await this.reply(msg.chatId, `已取消（无活跃执行器）· ${id}`);
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
    if (!msg.admin && task.requester !== msg.userId) {
      await this.reply(msg.chatId, "只有原请求者可以恢复。");
      return;
    }
    if (task.status !== "paused") {
      await this.reply(msg.chatId, `任务 ${id} 不是中断状态（${task.status}），只有中断的任务可以恢复。`);
      return;
    }
    // 策略改动不追溯：已建任务保留建单时的授权，恢复前按当前策略重新判定
    const recheck = decide(
      cfg,
      {
        source: task.mandate?.source ?? task.channel,
        principal: task.mandate?.principal ?? task.requester,
        mentioned: task.mandate?.mentioned ?? true,
      },
      this.now(),
    );
    if (recheck.mode !== "auto") {
      await this.reply(
        msg.chatId,
        [
          `拒绝恢复 · ${id}`,
          recheck.reason,
          `建单时策略 ${task.mandate?.policyVersion ?? "未知"}，当前策略 ${recheck.policyVersion}。`,
        ].join("\n"),
      );
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

  /**
   * 恢复任务时进度文件已转发到的位置：停在最后一个换行之后。
   * 上一轮写了一半的行留给下一轮补全后整行解析，避免半行被当成完整行丢弃。
   */
  private progressSeen(id: string): number {
    let buf = "";
    try {
      buf = readFileSync(join(resolve(this.deps.cfg.stateDir), "progress", `${id}.jsonl`), "utf8");
    } catch {
      return 0;
    }
    return buf.lastIndexOf("\n") + 1;
  }

  /** 轮询 pi 扩展写出的进度文件，节流后转发到对话；start 为已转发过的位置 */
  private watchProgress(task: Task, start: number): () => void {
    const file = join(resolve(this.deps.cfg.stateDir), "progress", `${task.id}.jsonl`);
    let size = start;
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

  /** 回帖到来源 PR / Issue：入队执行，失败留在队列重试，不改任务状态 */
  private async replyToSource(task: Task, summary: string, log: TaskLogger): Promise<void> {
    const gh = this.deps.cfg.github;
    // 多仓库：任务记住评论所在仓库；旧任务与 IM 触发的回帖退回配置里的单仓库
    const repo = task.replyRepo ?? githubRepos(gh)[0]?.repo;
    if (!gh?.enabled || !repo) return;
    const body = formatReply(summary);
    if (task.replyPr) await this.postReply(repo, task.replyPr, "pr", task, body, log);
    if (task.replyIssue) await this.postReply(repo, task.replyIssue, "issue", task, body, log);
  }

  /** 入队并尝试回帖一次：失败只记日志，effect 会按退避继续重试 */
  private async postReply(
    repo: string,
    n: number,
    purpose: "pr" | "issue",
    task: Task,
    body: string,
    log: TaskLogger,
  ): Promise<void> {
    const kind = purpose === "pr" ? "PR" : "Issue";
    let detail: string;
    try {
      const value = await this.effects.exec("comment", `${purpose}:${repo}#${n}:${task.id}`, task.id, {
        taskId: task.id,
        repo,
        number: n,
        purpose,
        body,
      });
      detail = value === "skipped" ? "已存在同标记回帖，跳过" : "已回帖";
    } catch (err) {
      detail = `回帖失败（已入队重试）：${(err as Error).message.slice(0, 500)}`;
    }
    log.write(`reply-${purpose}`, `${kind} #${n} ${detail}`);
  }

  /**
   * 失败/取消清理：只删任务自建的分支。
   * 续跑复用父任务分支时该分支是共享资产，删掉会毁掉上一轮成果与原 PR。
   */
  private cleanupBranch(repoPath: string, task: Task, branch: string): void {
    if (branch !== `pisa/${task.id}`) return;
    deleteBranch(repoPath, branch);
    this.deps.store.removeEffect(task.id, "branch", branch);
  }

  /** 移除工作副本并同步账本；账本只留仍然存在的副作用 */
  private dropWorktree(repoPath: string, task: Task, workdir: string): void {
    removeWorktree(repoPath, workdir);
    this.deps.store.removeEffect(task.id, "worktree", workdir);
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

    // 账本：工作副本与分支已落地；共享分支标明，撤销时不删
    store.effect(task.id, "worktree", workdir);
    store.effect(task.id, "branch", branch, branch === `pisa/${task.id}` ? null : "shared");

    await this.reply(task.chatId, `开始执行 · ${task.id}\n分支 ${branch}`, task.id);

    const stopWatch = this.progressOn
      ? this.watchProgress(task, resuming ? this.progressSeen(task.id) : 0)
      : () => {};
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
      this.dropWorktree(repo.path, task, workdir);
      this.cleanupBranch(repo.path, task, branch);
      this.effects.cancelTask(task.id);
      store.transition(task.id, "cancelled", { endedAt: this.now() });
      await this.reply(task.chatId, `已取消 · ${task.id}`);
      return;
    }

    if (!result.ok) {
      log.write("failed", result.error ?? "");
      this.dropWorktree(repo.path, task, workdir);
      this.cleanupBranch(repo.path, task, branch);
      this.effects.cancelTask(task.id);
      store.transition(task.id, "failed", { error: result.error ?? "未知错误", endedAt: this.now() });
      await this.reply(task.chatId, `失败 · ${task.id}\n${(result.error ?? "").slice(0, 800)}`, task.id);
      return;
    }

    let delivery;
    try {
      delivery = await deliverer.deliver({ ...task, branch }, workdir, repo, this.effects);
    } catch (err) {
      log.write("deliver", (err as Error).message);
      this.dropWorktree(repo.path, task, workdir);
      this.cleanupBranch(repo.path, task, branch);
      this.effects.cancelTask(task.id);
      store.transition(task.id, "failed", { error: (err as Error).message, endedAt: this.now() });
      await this.reply(task.chatId, `失败 · ${task.id}\n${(err as Error).message.slice(0, 800)}`);
      return;
    }

    // 账本：推送与 PR 由 outbox 在动作成功后记（含重启后的重放）；
    // 无改动时按分支认领到的 PR 不经过 effect，这里补记
    if (!task.prUrl) this.bookPr(task.id, repo.alias, delivery.prUrl ?? null);

    store.transition(task.id, "succeeded", {
      summary: result.summary,
      branch: delivery.branch ?? branch,
      prUrl: delivery.prUrl ?? null,
      endedAt: this.now(),
    });
    this.dropWorktree(repo.path, task, workdir);
    log.write("done", `files=${delivery.files.length} pushed=${delivery.pushed}`);
    await this.replyToSource(task, result.summary, log);

    const fresh = store.get(task.id);
    const lines = [`✅ ${task.id} 完成`, result.summary.slice(0, 1200)];
    if (delivery.files.length) lines.push(`改动 ${delivery.files.length} 个文件：${delivery.files.slice(0, 8).join(", ")}`);
    else lines.push("没有代码改动。");
    if (delivery.blocked.length) lines.push(`⚠️ 未提交的敏感路径：${delivery.blocked.slice(0, 8).join(", ")}`);
    if (delivery.branch) lines.push(`分支：${delivery.branch}`);
    if (delivery.prUrl) lines.push(`链接：${delivery.prUrl}`);
    if (fresh?.sessionId) lines.push(`会话：${fresh.sessionId.slice(0, 8)}`);
    await this.reply(task.chatId, lines.join("\n\n"), task.id);
  }
}
