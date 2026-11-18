import type { Config, RepoConfig } from "./config";
import type { DeliveryResult, Task } from "./types";
import { changedFiles, commitAll, compareUrl, hasGh, remoteUrl, sh } from "./git";
import type { EffectQueue, PrPayload, PushPayload } from "./effects";

export interface Deliverer {
  /** effects：外部动作入口；交付只负责入队与立即取结果，失败留在队列里重试 */
  deliver(task: Task, workdir: string, repo: RepoConfig, effects: EffectQueue): Promise<DeliveryResult>;
}

/** 审核与交付：PR 正文带上任务号与需求；Issue 来源追加 Closes 关联 */
export function prBody(task: Pick<Task, "id" | "prompt" | "replyIssue">): string {
  const lines = [`任务号：${task.id}`, task.prompt.trim(), "---", "由 pisa 自动创建。"];
  if (task.replyIssue) lines.push(`Closes #${task.replyIssue}`);
  return lines.filter((line) => line !== "").join("\n\n");
}

/** gh 能力的注入点：测试用假实现验证「已有 PR 时不新建 PR」 */
export interface DelivererDeps {
  hasGh?: () => boolean;
}

export class GitDeliverer implements Deliverer {
  constructor(
    private cfg: Config,
    private deps: DelivererDeps = {},
  ) {}

  async deliver(task: Task, workdir: string, repo: RepoConfig, effects: EffectQueue): Promise<DeliveryResult> {
    const files = changedFiles(workdir);
    // 续跑既有 PR 时没有改动也要保住 PR 绑定
    if (files.length === 0) return { files: [], pushed: false, prUrl: task.prUrl ?? undefined };

    const base = repo.baseBranch ?? "main";
    const branch = task.branch ?? `pisa/${task.id}`;
    const title = `pisa: ${task.prompt.split("\n")[0]?.slice(0, 60) ?? task.id}`;

    const commit = commitAll(workdir, `${title}\n\n任务: ${task.id}`, this.cfg.delivery.commitName, this.cfg.delivery.commitEmail);
    if (commit.code !== 0) throw new Error(`提交失败: ${commit.err || commit.out}`);

    const remote = repo.remote ?? remoteUrl(workdir);
    const wantPush = Boolean(this.cfg.delivery.push && remote);

    // 推送按 (branch, head) 去重：同一提交只推一次，失败退避后由队列重试
    let pushed = false;
    if (wantPush) {
      const head = sh(["git", "-C", workdir, "rev-parse", "HEAD"]).out.trim();
      const key = `${branch}@${head}`;
      const payload: PushPayload = { taskId: task.id, repoPath: repo.path, branch };
      effects.enqueue("push", key, payload);
      pushed = (await effects.runNow("push", key)).ok;
    }

    // 已有 PR：分支推送即更新 PR，不再新建
    let prUrl: string | undefined = task.prUrl ?? undefined;
    const wantPr = Boolean(this.cfg.delivery.pr && pushed && remote.includes("github.com") && (this.deps.hasGh ?? hasGh)());
    if (wantPr && !prUrl) {
      const key = `${repo.alias}:${branch}`;
      const payload: PrPayload = {
        taskId: task.id,
        alias: repo.alias,
        repoPath: repo.path,
        base,
        head: branch,
        title,
        body: prBody(task),
      };
      effects.enqueue("pr", key, payload);
      const res = await effects.runNow("pr", key);
      if (res.ok && typeof res.result === "string") prUrl = res.result;
    }

    if (!prUrl && remote) {
      prUrl = compareUrl(remote, base, branch) ?? undefined;
    }

    return { branch, prUrl, files, pushed };
  }
}
