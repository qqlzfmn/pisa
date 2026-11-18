import type { Config, RepoConfig } from "./config";
import type { DeliveryResult, Task } from "./types";
import {
  changedFiles,
  commitAll,
  compareUrl,
  createPr,
  findPr,
  hasGh,
  pushedBranch,
  pushBranch,
  remoteUrl,
} from "./git";

export interface Deliverer {
  deliver(task: Task, workdir: string, repo: RepoConfig): Promise<DeliveryResult>;
}

/** 审核与交付：PR 正文带上任务号与需求；Issue 来源追加 Closes 关联 */
export function prBody(task: Pick<Task, "id" | "prompt" | "replyIssue">): string {
  const lines = [`任务号：${task.id}`, task.prompt.trim(), "---", "由 pisa 自动创建。"];
  if (task.replyIssue) lines.push(`Closes #${task.replyIssue}`);
  return lines.filter((line) => line !== "").join("\n\n");
}

/** gh 能力的注入点：测试用假实现验证「更新既有 PR 时不新建 PR」「按分支认领已有 PR」 */
export interface DelivererDeps {
  createPr?: typeof createPr;
  findPr?: typeof findPr;
  hasGh?: () => boolean;
}

export class GitDeliverer implements Deliverer {
  constructor(
    private cfg: Config,
    private deps: DelivererDeps = {},
  ) {}

  async deliver(task: Task, workdir: string, repo: RepoConfig): Promise<DeliveryResult> {
    const files = changedFiles(workdir);
    const base = repo.baseBranch ?? "main";
    const branch = task.branch ?? `pisa/${task.id}`;
    const remote = repo.remote ?? remoteUrl(workdir);
    // 建/查 PR 的前提：配置开启、远端是 GitHub、本机有 gh
    const prReady = this.cfg.delivery.pr && remote.includes("github.com") && (this.deps.hasGh ?? hasGh)();

    // 续跑既有 PR 时没有改动也要保住 PR 绑定；上次建好 PR 却没来得及记账时按分支认领
    if (files.length === 0) {
      const claimed = !task.prUrl && prReady && pushedBranch(workdir, branch) ? this.claimPr(workdir, branch) : undefined;
      return { files: [], pushed: false, prUrl: task.prUrl ?? claimed };
    }

    const title = `pisa: ${task.prompt.split("\n")[0]?.slice(0, 60) ?? task.id}`;

    const commit = commitAll(workdir, `${title}\n\n任务: ${task.id}`, this.cfg.delivery.commitName, this.cfg.delivery.commitEmail);
    if (commit.code !== 0) throw new Error(`提交失败: ${commit.err || commit.out}`);

    let pushed = false;
    if (this.cfg.delivery.push && remote) {
      const p = pushBranch(workdir, branch);
      if (p.code !== 0) throw new Error(`推送失败: ${p.err || p.out}`);
      pushed = true;
    }

    // 已有 PR：分支推送即更新 PR，不再新建；远端同 head 的 PR 说明上次建好没记账，认领它
    const existing = task.prUrl ?? (prReady && pushed ? this.claimPr(workdir, branch) : undefined);
    if (existing) return { branch, prUrl: existing, files, pushed };

    let prUrl: string | undefined;
    if (prReady && pushed) {
      const pr = (this.deps.createPr ?? createPr)(workdir, {
        title,
        body: prBody(task),
        base,
        head: branch,
      });
      if (pr.code === 0) prUrl = pr.out.split("\n").pop()?.trim();
    }

    if (!prUrl && remote) {
      prUrl = compareUrl(remote, base, branch) ?? undefined;
    }

    return { branch, prUrl, files, pushed };
  }

  /** 分支上已有的开放 PR；查不到或 gh 失败按没有处理，交给 createPr */
  private claimPr(workdir: string, branch: string): string | undefined {
    const found = (this.deps.findPr ?? findPr)(workdir, branch);
    return found.code === 0 ? found.out.trim() || undefined : undefined;
  }
}
