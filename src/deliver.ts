import type { Config, RepoConfig } from "./config";
import { repoByAlias } from "./config";
import type { DeliveryResult, EffectJob, Task } from "./types";
import type { EffectEnqueuer } from "./effects";
import {
  changedFiles,
  commitAll,
  compareUrl,
  createPr,
  hasGh,
  pushBranch,
  remoteUrl,
  sh,
} from "./git";

export interface Deliverer {
  deliver(task: Task, workdir: string, repo: RepoConfig, effects: EffectEnqueuer): Promise<DeliveryResult>;
  /** 执行入队的 push / pr；失败抛出，由 EffectQueue 退避重试 */
  runEffect(job: EffectJob): Promise<string | null>;
}

/** 审核与交付：PR 正文带上任务号与需求；Issue 来源追加 Closes 关联 */
export function prBody(task: Pick<Task, "id" | "prompt" | "replyIssue">): string {
  const lines = [`任务号：${task.id}`, task.prompt.trim(), "---", "由 pisa 自动创建。"];
  if (task.replyIssue) lines.push(`Closes #${task.replyIssue}`);
  return lines.filter((line) => line !== "").join("\n\n");
}

/** gh 能力的注入点：测试用假实现验证「更新既有 PR 时不新建 PR」 */
export interface DelivererDeps {
  createPr?: typeof createPr;
  hasGh?: () => boolean;
}

export class GitDeliverer implements Deliverer {
  constructor(
    private cfg: Config,
    private deps: DelivererDeps = {},
  ) {}

  async deliver(
    task: Task,
    workdir: string,
    repo: RepoConfig,
    effects: EffectEnqueuer,
  ): Promise<DeliveryResult> {
    const files = changedFiles(workdir);
    // 续跑既有 PR 时没有改动也要保住 PR 绑定
    if (files.length === 0) return { files: [], pushed: false, prUrl: task.prUrl ?? undefined };

    const base = repo.baseBranch ?? "main";
    const branch = task.branch ?? `pisa/${task.id}`;
    const title = `pisa: ${task.prompt.split("\n")[0]?.slice(0, 60) ?? task.id}`;

    const commit = commitAll(workdir, `${title}\n\n任务: ${task.id}`, this.cfg.delivery.commitName, this.cfg.delivery.commitEmail);
    if (commit.code !== 0) throw new Error(`提交失败: ${commit.err || commit.out}`);

    const remote = repo.remote ?? remoteUrl(workdir);
    let pushed = false;

    if (this.cfg.delivery.push && remote) {
      // 推送按提交去重：同一提交只推一次，续跑产生的新提交照常推
      const sha = sh(["git", "-C", workdir, "rev-parse", "HEAD"]).out;
      const outcome = await effects.enqueue("push", `${repo.alias}:${branch}:${sha}`, {
        repo: repo.alias,
        branch,
      });
      if (!outcome.ok) throw new Error(`推送失败: ${outcome.error}`);
      pushed = true;
    }

    // 已有 PR：分支推送即更新 PR，不再新建
    if (task.prUrl) return { branch, prUrl: task.prUrl, files, pushed };

    let prUrl: string | undefined;
    if (this.cfg.delivery.pr && pushed && remote.includes("github.com") && (this.deps.hasGh ?? hasGh)()) {
      // 同分支只开一个 PR：上一次入队成功的行直接复用地址
      const outcome = await effects.enqueue("pr", `${repo.alias}:${branch}`, {
        repo: repo.alias,
        title,
        body: prBody(task),
        base,
        head: branch,
      });
      if (outcome.ok && outcome.result) prUrl = outcome.result;
    }

    if (!prUrl && remote) {
      prUrl = compareUrl(remote, base, branch) ?? undefined;
    }

    return { branch, prUrl, files, pushed };
  }

  async runEffect(job: EffectJob): Promise<string | null> {
    const alias = String(job.payload.repo);
    const repo = repoByAlias(this.cfg, alias);
    if (!repo) throw new Error(`仓库未配置：${alias}`);

    if (job.kind === "push") {
      const branch = String(job.payload.branch);
      const res = pushBranch(repo.path, branch);
      if (res.code !== 0) throw new Error(res.err || res.out || `git push 退出码 ${res.code}`);
      return null;
    }
    if (job.kind !== "pr") throw new Error(`交付器不处理 ${job.kind} effect`);

    // 从主仓库执行：工作副本可能已被清理，分支引用仍在共享的 .git 里
    const pr = (this.deps.createPr ?? createPr)(repo.path, {
      title: String(job.payload.title),
      body: String(job.payload.body),
      base: String(job.payload.base),
      head: String(job.payload.head),
    });
    if (pr.code !== 0) throw new Error(pr.err || pr.out || `gh pr create 退出码 ${pr.code}`);
    return pr.out.split("\n").pop()?.trim() || null;
  }
}
