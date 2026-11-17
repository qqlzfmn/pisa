import { githubRepos, type Config } from "./config";
import type { Store } from "./store";
import type { IncomingMessage } from "./types";
import { defaultRunner, isPullRequest, listComments, prNumberFromIssueUrl, type Runner } from "./github";

type Enqueue = (m: IncomingMessage) => Promise<void> | void;

export interface GithubWatcherDeps {
  cfg: Config;
  store: Store;
  enqueue: Enqueue;
  /** 默认走真实 gh 命令，测试注入假实现 */
  runner?: Runner;
  now?: () => number;
}

/**
 * Issue / PR 评论 → 任务：按仓库定时拉增量评论，把带触发词的投给 Router。
 * 去重靠投递时的稳定 eventId（`github:comment:<repo>:<id>`），由 Router 的 claimEvent 落库。
 * 每个仓库各自维护增量下界，一个仓库失败不影响其它仓库。
 * 编号是 PR 时接续该 PR 的任务并回帖到 PR；是普通 Issue 时从主干开新分支、回帖到 Issue。
 */
export class GithubWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** 每个仓库的增量下界：只在整轮成功后推进，失败不推进以免漏评论 */
  private readonly since = new Map<string, string>();
  /** 允许派活的评论作者，login 小写归一；空集合 = 未配置，评论派活禁用 */
  private readonly allowedAuthors: Set<string>;
  private readonly now: () => number;
  private readonly runner: Runner;

  constructor(private deps: GithubWatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.runner = deps.runner ?? defaultRunner;
    this.allowedAuthors = new Set(
      (deps.cfg.github?.allowedUsers ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
    );
    // 启动时刻即下界：不回放历史评论
    const startedAt = new Date(this.now()).toISOString();
    for (const target of githubRepos(deps.cfg.github)) this.since.set(target.repo, startedAt);
  }

  start(): void {
    const gh = this.deps.cfg.github;
    if (!gh?.enabled || this.timer) return;
    // 空名单不猜默认值：评论作者不可信，未配置就整体不派活
    if (this.allowedAuthors.size === 0) {
      console.warn("[pisa] 评论来源未配置 allowedUsers，评论派活已禁用");
      return;
    }
    const every = Math.max(10, gh.intervalSec ?? 120) * 1000;
    this.timer = setInterval(() => void this.poll(), every);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    const gh = this.deps.cfg.github;
    if (!gh?.enabled || this.polling || this.allowedAuthors.size === 0) return;
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
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollRepo(repo: string, chatId: string, userId: string, startedAt: string): Promise<void> {
    const since = this.since.get(repo) ?? startedAt;
    const res = listComments(this.runner, repo, since);
    if (!res.ok) {
      console.warn(`[pisa] GitHub 评论拉取失败 · ${repo}：${res.error.slice(0, 300)}`);
      return;
    }

    const prefix = `${this.deps.cfg.trigger} `;
    // 类型判定失败不推进下界：下一轮重试，已投递的评论由 eventId 去重
    let complete = true;
    for (const comment of res.value) {
      const text = comment.body.trim();
      if (!text.startsWith(prefix)) continue;
      // 评论者身份与配置归属身份分开：只有白名单作者的评论能派活
      if (!this.allowedAuthors.has(comment.userLogin.trim().toLowerCase())) {
        console.warn(
          `[pisa] 忽略非白名单作者的评论 · ${repo} #${comment.id} @${comment.userLogin || "(未知)"}`,
        );
        continue;
      }
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
        // 归属与回帖路由仍用配置身份；评论作者单独带出，只做审计
        userId,
        author: comment.userLogin,
        text,
        replyRepo: repo,
      };
      if (isPr.value) {
        await this.deps.enqueue({ ...base, continueFrom: this.deps.store.taskByPr(n, repo)?.id, replyPr: n });
      } else {
        // Issue 没有父分支：从主干开新分支，完成后回帖到 Issue
        await this.deps.enqueue({ ...base, replyIssue: n });
      }
    }
    if (complete) this.since.set(repo, startedAt);
  }
}
