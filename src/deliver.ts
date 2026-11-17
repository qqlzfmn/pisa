import type { Config, RepoConfig } from "./config";
import type { DeliveryResult, Task } from "./types";
import {
  changedFiles,
  commitAll,
  compareUrl,
  createPr,
  hasGh,
  pushBranch,
  remoteUrl,
} from "./git";

export interface Deliverer {
  deliver(task: Task, workdir: string, repo: RepoConfig): Promise<DeliveryResult>;
}

export class GitDeliverer implements Deliverer {
  constructor(private cfg: Config) {}

  async deliver(task: Task, workdir: string, repo: RepoConfig): Promise<DeliveryResult> {
    const files = changedFiles(workdir);
    if (files.length === 0) return { files: [], pushed: false };

    const base = repo.baseBranch ?? "main";
    const branch = task.branch ?? `pisa/${task.id}`;
    const title = `pisa: ${task.prompt.split("\n")[0]?.slice(0, 60) ?? task.id}`;

    const commit = commitAll(workdir, `${title}\n\n任务: ${task.id}`, this.cfg.delivery.commitName, this.cfg.delivery.commitEmail);
    if (commit.code !== 0) throw new Error(`提交失败: ${commit.err || commit.out}`);

    const remote = repo.remote ?? remoteUrl(workdir);
    let pushed = false;

    if (this.cfg.delivery.push && remote) {
      const p = pushBranch(workdir, branch);
      if (p.code !== 0) throw new Error(`推送失败: ${p.err || p.out}`);
      pushed = true;
    }

    let prUrl: string | undefined;
    if (this.cfg.delivery.pr && pushed && remote.includes("github.com") && hasGh()) {
      const pr = createPr(workdir, {
        title,
        body: `任务号：${task.id}\n\n${task.prompt}\n\n---\n由 pisa 自动创建。`,
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
}
