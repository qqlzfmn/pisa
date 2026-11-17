import type { Config } from "./config";
import type { Store } from "./store";
import type { IncomingMessage } from "./types";
import { defaultRunner, listComments, prNumberFromIssueUrl, type Runner } from "./github";

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
 * PR 评论 → 任务：定时拉增量评论，把带触发词的投给 Router。
 * 去重靠投递时的稳定 eventId（`github:comment:<id>`），由 Router 的 claimEvent 落库。
 */
export class GithubWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** 增量下界：只在整轮成功后推进，失败不推进以免漏评论 */
  private since: string;
  private readonly now: () => number;
  private readonly runner: Runner;

  constructor(private deps: GithubWatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.runner = deps.runner ?? defaultRunner;
    // 启动时刻即下界：不回放历史评论
    this.since = new Date(this.now()).toISOString();
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
    const startedAt = this.now();
    try {
      const res = listComments(this.runner, gh.repo, this.since);
      if (!res.ok) {
        console.warn(`[pisa] GitHub 评论拉取失败：${res.error.slice(0, 300)}`);
        return;
      }
      this.since = new Date(startedAt).toISOString();

      const prefix = `${this.deps.cfg.trigger} `;
      for (const comment of res.value) {
        const text = comment.body.trim();
        if (!text.startsWith(prefix)) continue;
        const pr = prNumberFromIssueUrl(comment.issueUrl);
        if (!pr) continue;
        await this.deps.enqueue({
          eventId: `github:comment:${comment.id}`,
          channel: "github",
          chatId: gh.chatId,
          userId: gh.userId,
          text,
          continueFrom: this.deps.store.taskByPr(pr)?.id,
          replyPr: pr,
        });
      }
    } finally {
      this.polling = false;
    }
  }
}
