import type { Config, RepoConfig } from "./config";
import type { DeliveryResult, Task } from "./types";
import type { EffectHandler, EffectQueue } from "./effects";
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

/** 交付阶段注册进 outbox 的外部动作 */
export interface DeliveryHandlers {
  push: EffectHandler<"push">;
  pr: EffectHandler<"pr">;
}

export interface Deliverer {
  deliver(task: Task, workdir: string, repo: RepoConfig, effects: EffectQueue): Promise<DeliveryResult>;
  /** 推送与建 PR 的 outbox handler：先落库再由 EffectQueue 执行，失败退避重试 */
  effectHandlers(): DeliveryHandlers;
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

  effectHandlers(): DeliveryHandlers {
    return {
      push: async (p) => {
        const res = pushBranch(p.repoPath, p.branch);
        if (res.code !== 0) throw new Error(`推送失败: ${res.err || res.out}`);
        return null;
      },
      // 先认领同 head 的开放 PR：上次建好却没标记完成时，重试拿到同一个 PR 而不是再建一个
      pr: async (p) => {
        const claimed = this.claimPr(p.repoPath, p.branch);
        if (claimed) return { url: claimed };
        const pr = (this.deps.createPr ?? createPr)(p.repoPath, { title: p.title, body: p.body, base: p.base, head: p.branch });
        if (pr.code !== 0) throw new Error(`创建 PR 失败: ${pr.err || pr.out}`);
        return { url: pr.out.split("\n").pop()?.trim() || null };
      },
    };
  }

  async deliver(task: Task, workdir: string, repo: RepoConfig, effects: EffectQueue): Promise<DeliveryResult> {
    const changes = changedFiles(workdir);
    const base = repo.baseBranch ?? "main";
    const branch = task.branch ?? `pisa/${task.id}`;
    const remote = repo.remote ?? remoteUrl(workdir);
    // 建/查 PR 的前提：配置开启、远端是 GitHub、本机有 gh
    const prReady = this.cfg.delivery.pr && remote.includes("github.com") && (this.deps.hasGh ?? hasGh)();

    const title = `pisa: ${task.prompt.split("\n")[0]?.slice(0, 60) ?? task.id}`;
    // 有改动才 add + commit；commitAll 会先把敏感路径剔出索引，全被拦下时不产生空提交
    const commit = changes.length === 0 ? null : commitAll(workdir, `${title}\n\n任务: ${task.id}`, this.cfg.delivery.commitName, this.cfg.delivery.commitEmail);
    if (commit && commit.code !== 0) throw new Error(`提交失败: ${commit.err || commit.out}`);
    const { files, blocked } = commit ?? { files: [], blocked: [] };

    // 没有可交付的改动：续跑既有 PR 时也要保住绑定；上次建好 PR 却没记账时按分支认领
    if (files.length === 0) {
      const claimed = !task.prUrl && prReady && pushedBranch(workdir, branch) ? this.claimPr(repo.path, branch) : undefined;
      return { files: [], blocked, pushed: false, prUrl: task.prUrl ?? claimed };
    }

    let pushed = false;
    if (this.cfg.delivery.push && remote) {
      await effects.exec("push", `${task.id}:${branch}`, task.id, { taskId: task.id, repoPath: repo.path, branch });
      pushed = true;
    }

    // 已有 PR：分支推送即更新 PR，不再新建；远端同 head 的 PR 说明上次建好没记账，认领它
    const existing = task.prUrl ?? (prReady && pushed ? this.claimPr(repo.path, branch) : undefined);
    if (existing) return { branch, prUrl: existing, files, pushed, blocked };

    let prUrl: string | undefined;
    if (prReady && pushed) {
      try {
        const res = await effects.exec("pr", `${task.id}:${branch}`, task.id, {
          taskId: task.id,
          repoPath: repo.path,
          branch,
          base,
          title,
          body: prBody(task),
          repo: repo.alias,
        });
        prUrl = res.url ?? undefined;
      } catch {
        // 建 PR 失败留在队列里退避重试；本轮退回 compare 链接，不改任务终态
      }
    }

    if (!prUrl && remote) {
      prUrl = compareUrl(remote, base, branch) ?? undefined;
    }

    return { branch, prUrl, files, pushed, blocked };
  }

  /** 分支上已有的开放 PR；查不到或 gh 失败按没有处理，交给 createPr */
  private claimPr(workdir: string, branch: string): string | undefined {
    const found = (this.deps.findPr ?? findPr)(workdir, branch);
    return found.code === 0 ? found.out.trim() || undefined : undefined;
  }
}
