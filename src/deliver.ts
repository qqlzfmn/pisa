import type { Config, RepoConfig } from "./config";
import type { EffectQueue } from "./effects";
import { defaultRunner, findOpenPr, prNumberFromIssueUrl, repoFromRemote, type Runner } from "./github";
import { changedFiles, commitAll, compareUrl, createPr, hasGh, pushBranch, remoteUrl } from "./git";
import type { Store } from "./store";
import type { DeliveryResult, Task } from "./types";

export interface Deliverer {
  deliver(task: Task, workdir: string, repo: RepoConfig): Promise<DeliveryResult>;
}

/** 审核与交付：PR 正文带上任务号与需求；Issue 来源追加 Closes 关联 */
export function prBody(task: Pick<Task, "id" | "prompt" | "replyIssue">): string {
  const lines = [`任务号：${task.id}`, task.prompt.trim(), "---", "由 pisa 自动创建。"];
  if (task.replyIssue) lines.push(`Closes #${task.replyIssue}`);
  return lines.filter((line) => line !== "").join("\n\n");
}

/** 推送动作的载荷：工作副本可能已被回收，统一从仓库目录推分支 */
interface PushPayload {
  repoPath: string;
  branch: string;
}

interface PrPayload {
  repoPath: string;
  repo: string;
  alias: string;
  title: string;
  body: string;
  base: string;
  head: string;
}

/** gh 能力的注入点：测试用假实现验证「复用已有 PR 时不新建 PR」 */
export interface DelivererDeps {
  createPr?: typeof createPr;
  hasGh?: () => boolean;
  findPr?: typeof findOpenPr;
  /** PR 存在性查询用的 gh 执行器；默认真跑 */
  runner?: Runner;
  store: Store;
  effects: EffectQueue;
}

/**
 * 交付 = 提交 + 推送 + 建 PR。推送与 PR 是外部动作：先落库成 effect 再执行，
 * 失败按退避重试，进程重启后由队列继续，重试时复用已存在的分支与 PR。
 */
export class GitDeliverer implements Deliverer {
  private readonly store: Store;
  private readonly effects: EffectQueue;

  constructor(
    private cfg: Config,
    private deps: DelivererDeps,
  ) {
    this.store = deps.store;
    this.effects = deps.effects;
    this.effects.register("push", (payload, ctx) => this.runPush(payload as PushPayload, ctx.taskId));
    this.effects.register("pr", (payload, ctx) => this.runPr(payload as PrPayload, ctx.taskId));
  }

  async deliver(task: Task, workdir: string, repo: RepoConfig): Promise<DeliveryResult> {
    const files = changedFiles(workdir);
    // 续跑既有 PR 时没有改动也要保住 PR 绑定
    if (files.length === 0) return { files: [], pushed: false, prUrl: task.prUrl ?? undefined };

    const base = repo.baseBranch ?? "main";
    const branch = task.branch ?? `pisa/${task.id}`;
    const title = `pisa: ${task.prompt.split("\n")[0]?.slice(0, 60) ?? task.id}`;

    const commit = commitAll(workdir, `${title}\n\n任务: ${task.id}`, this.cfg.delivery.commitName, this.cfg.delivery.commitEmail);
    if (commit.code !== 0) throw new Error(`提交失败: ${commit.err || commit.out}`);

    const remote = repo.remote ?? remoteUrl(workdir);
    const ghReady = this.deps.hasGh ?? hasGh;
    const repoSlug = remote ? repoFromRemote(remote) : null;
    const withPush = this.cfg.delivery.push && Boolean(remote);
    // 已有 PR：分支推送即更新 PR，不再新建
    const createNew = this.cfg.delivery.pr && Boolean(repoSlug) && ghReady() && !task.prUrl;

    if (withPush) this.effects.enqueue("push", task.id, { repoPath: repo.path, branch } satisfies PushPayload, task.id);
    if (createNew) {
      const payload: PrPayload = {
        repoPath: repo.path,
        repo: repoSlug!,
        alias: repo.alias,
        title,
        body: prBody(task),
        base,
        head: branch,
      };
      this.effects.enqueue("pr", task.id, payload, task.id);
    }

    // PR 依赖分支先到位：先推，再建
    if (withPush) await this.effects.flush("push", task.id);
    if (createNew) await this.effects.flush("pr", task.id);

    const push = withPush ? this.effects.state("push", task.id) : null;
    const pr = createNew ? this.effects.state("pr", task.id) : null;
    const pushed = push?.state === "done";
    let prUrl = task.prUrl ?? (pr?.state === "done" && typeof pr.result === "string" ? pr.result : undefined);
    // 推送失败时分支可能没上去，compare 链接没有意义
    if (!prUrl && remote && push?.state !== "pending" && push?.state !== "running") {
      prUrl = compareUrl(remote, base, branch) ?? undefined;
    }

    return { branch, prUrl, files, pushed };
  }

  /** 推送执行器：同分支重复推送是覆盖写，天然幂等 */
  private runPush(payload: PushPayload, taskId: string | null): string {
    const p = pushBranch(payload.repoPath, payload.branch);
    if (p.code !== 0) throw new Error(`推送失败: ${p.err || p.out}`);
    if (taskId) this.store.effect(taskId, "push", "origin", payload.branch);
    return payload.branch;
  }

  /** PR 执行器：先查同 head 的开放 PR，命中就复用，重放不会产生第二个 PR */
  private runPr(payload: PrPayload, taskId: string | null): string {
    if (!taskId) throw new Error("PR effect 缺少任务号");
    const push = this.effects.state("push", taskId);
    if (push && push.state !== "done") throw new Error("分支尚未推送完成，等待重试");

    const findPr = this.deps.findPr ?? findOpenPr;
    const found = findPr(this.deps.runner ?? defaultRunner, payload.repo, payload.head);
    if (!found.ok) throw new Error(`查询已有 PR 失败：${found.error}`);
    const url = found.value ?? this.createPr(payload);

    this.store.effect(taskId, "pr", String(prNumberFromIssueUrl(url) ?? url), payload.alias);
    this.store.setPrUrl(taskId, url);
    return url;
  }

  private createPr(payload: PrPayload): string {
    const pr = (this.deps.createPr ?? createPr)(payload.repoPath, {
      title: payload.title,
      body: payload.body,
      base: payload.base,
      head: payload.head,
    });
    if (pr.code !== 0) throw new Error(`创建 PR 失败: ${pr.err || pr.out}`);
    const url = pr.out.split("\n").pop()?.trim();
    if (!url) throw new Error("创建 PR 失败: gh 没有输出链接");
    return url;
  }
}
