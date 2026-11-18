import { githubRepos, type Config } from "./config";
import type { Store } from "./store";
import type { IncomingMessage } from "./types";
import { defaultRunner, isPullRequest, listComments, listOpenPrs, prNumberFromIssueUrl, reviewRequest, type Runner } from "./github";

type Enqueue = (m: IncomingMessage) => Promise<void> | void;

export interface GithubWatcherDeps {
  cfg: Config;
  store: Store;
  enqueue: Enqueue;
  /** 默认走真实 gh 命令，测试注入假实现 */
  runner?: Runner;
  now?: () => number;
}

/** 每个仓库的增量游标落库键：重启后从上次整轮成功的位置继续 */
function sinceKey(repo: string): string {
  return `github:since:${repo}`;
}

/** 评审基线：启用时刻之前创建的 PR 只记 head，不建任务 */
function reviewSinceKey(repo: string): string {
  return `github:review:since:${repo}`;
}

/** 每个 PR 已投递评审的 head SHA */
function reviewedKey(repo: string, n: number): string {
  return `github:review:${repo}#${n}`;
}

/**
 * Issue / PR 评论 → 任务：按仓库定时拉增量评论，把带触发词的投给 Router。
 * 身份靠 (线程, 评论 id, 编辑时间)：线程是 `github:<repo>:issue:<n>`，
 * 同一条评论被编辑后带上新版本，由 Router 挂回原任务而不是新建。
 * 每个仓库各自维护增量下界并落库（`meta` 表的 `github:since:<repo>`），一个仓库失败不影响其它仓库。
 * 编号是 PR 时接续该 PR 的任务并回帖到 PR；是普通 Issue 时从主干开新分支、回帖到 Issue。
 */
export class GithubWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly now: () => number;
  private readonly runner: Runner;

  constructor(private deps: GithubWatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.runner = deps.runner ?? defaultRunner;
    // 游标是进度状态：旧库没有记录才用启动时刻初始化，之后跨重启续用
    const startedAt = new Date(this.now()).toISOString();
    for (const target of githubRepos(deps.cfg.github)) {
      const key = sinceKey(target.repo);
      if (deps.store.getMeta(key) === null) deps.store.setMeta(key, startedAt);
      if (deps.cfg.github?.review?.enabled) {
        const reviewKey = reviewSinceKey(target.repo);
        if (deps.store.getMeta(reviewKey) === null) deps.store.setMeta(reviewKey, startedAt);
      }
    }
  }

  start(): void {
    const gh = this.deps.cfg.github;
    if (!gh?.enabled || this.timer) return;
    const every = Math.max(10, gh.intervalSec ?? 120) * 1000;
    this.timer = setInterval(() => void this.poll(), every);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    const gh = this.deps.cfg.github;
    if (!gh?.enabled || this.polling) return;
    this.polling = true;
    const startedAt = new Date(this.now()).toISOString();
    try {
      for (const target of githubRepos(gh)) {
        try {
          await this.pollRepo(target.repo, target.chatId, target.userId, startedAt);
        } catch (err) {
          // 投递异常只影响本仓库：下界不推进，下一轮重试
          console.warn(`[pisa] GitHub 评论投递失败 · ${target.repo}：${String(err).slice(0, 300)}`);
        }
        if (gh.review?.enabled) {
          try {
            await this.pollReviews(target.repo, target.chatId, target.userId, startedAt);
          } catch (err) {
            // 评审发现失败不影响评论链路；每个 PR 的已评审 SHA 未推进，下一轮重试
            console.warn(`[pisa] GitHub 评审发现失败 · ${target.repo}：${String(err).slice(0, 300)}`);
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollRepo(repo: string, chatId: string, userId: string, startedAt: string): Promise<void> {
    const since = this.deps.store.getMeta(sinceKey(repo)) ?? startedAt;
    const res = listComments(this.runner, repo, since);
    if (!res.ok) {
      console.warn(`[pisa] GitHub 评论拉取失败 · ${repo}：${res.error.slice(0, 300)}`);
      return;
    }

    const prefix = `${this.deps.cfg.trigger} `;
    // 类型判定失败不推进下界：下一轮重试，已投递的评论由触发器身份去重
    let complete = true;
    for (const comment of res.value) {
      const text = comment.body.trim();
      if (!text.startsWith(prefix)) continue;
      const n = prNumberFromIssueUrl(comment.issueUrl);
      if (!n) continue;
      const isPr = isPullRequest(this.runner, repo, n);
      if (!isPr.ok) {
        console.warn(`[pisa] GitHub 评论类型判定失败 · ${repo} #${n}：${isPr.error.slice(0, 300)}`);
        complete = false;
        continue;
      }
      const base = {
        eventId: `github:comment:${repo}:${comment.id}`,
        channel: "github",
        chatId,
        userId,
        text,
        replyRepo: repo,
        threadKey: `github:${repo}:issue:${n}`,
        messageKey: String(comment.id),
        version: comment.updatedAt,
        actor: comment.userLogin,
      };
      if (isPr.value) {
        await this.deps.enqueue({ ...base, continueFrom: this.deps.store.taskByPr(n, repo)?.id, replyPr: n });
      } else {
        // Issue 没有父分支：从主干开新分支，完成后回帖到 Issue
        await this.deps.enqueue({ ...base, replyIssue: n });
      }
    }
    if (complete) this.deps.store.setMeta(sinceKey(repo), startedAt);
  }

  /**
   * 新 PR（含已有 PR 的新 head）→ 只读评审任务。
   * 基线之前创建的 PR 只记 head，不回填；同一 head SHA 由 meta 与触发器双重去重。
   */
  private async pollReviews(repo: string, chatId: string, userId: string, startedAt: string): Promise<void> {
    const since = this.deps.store.getMeta(reviewSinceKey(repo)) ?? startedAt;
    const res = listOpenPrs(this.runner, repo);
    if (!res.ok) {
      console.warn(`[pisa] GitHub PR 列表拉取失败 · ${repo}：${res.error.slice(0, 300)}`);
      return;
    }

    for (const pr of res.value) {
      const key = reviewedKey(repo, pr.number);
      const seen = this.deps.store.getMeta(key);
      if (seen === pr.headSha) continue;
      // 启用前就存在的开放 PR：记下当前 head 作为基线，之后的新提交仍会评审
      const created = Date.parse(pr.createdAt);
      if (seen === null && Number.isFinite(created) && created < Date.parse(since)) {
        this.deps.store.setMeta(key, pr.headSha);
        continue;
      }
      await this.deps.enqueue({
        eventId: `github:review:${repo}:${pr.number}:${pr.headSha}`,
        channel: "github",
        chatId,
        userId,
        text: `${this.deps.cfg.trigger} ${reviewRequest(pr)}`,
        replyRepo: repo,
        replyPr: pr.number,
        threadKey: `github:${repo}:review:${pr.number}`,
        messageKey: pr.headSha,
        actor: pr.authorLogin,
        readonly: true,
        review: { head: pr.headSha, base: pr.baseRefName || "main" },
      });
      this.deps.store.setMeta(key, pr.headSha);
    }
  }
}
