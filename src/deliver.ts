import type { Config, RepoConfig } from "./config";
import type { DeliveryResult, Task } from "./types";
import {
  branchEntries,
  changedFiles,
  commitStaged,
  compareUrl,
  createPr,
  hasGh,
  pushBranch,
  remoteUrl,
  stageAllExcept,
} from "./git";

export interface Deliverer {
  deliver(task: Task, workdir: string, repo: RepoConfig): Promise<DeliveryResult>;
}

/** 交付前拦下的路径：凭据与 CI 定义。按路径分拣，不信任 .gitignore（agent 可以改） */
const SENSITIVE: RegExp[] = [
  // CI 定义：推送后在仓库凭据下自动执行，等于远端代码执行
  /^\.github\/(?:workflows|actions)\//,
  // 凭据与密钥：任意深度的同名文件
  /(?:^|\/)\.env/,
  /\.pem$/,
  /\.key$/,
  /(?:^|\/)id_/,
  /(?:^|\/)\.npmrc$/,
  /(?:^|\/)\.netrc$/,
  /(?:^|\/)secrets/,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE.some((re) => re.test(path));
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

  async deliver(task: Task, workdir: string, repo: RepoConfig): Promise<DeliveryResult> {
    // 续跑既有 PR 时没有改动也要保住 PR 绑定
    if (changedFiles(workdir).length === 0) {
      return { files: [], blocked: [], pushed: false, prUrl: task.prUrl ?? undefined };
    }

    const stage = stageAllExcept(workdir, isSensitivePath);
    if (stage.err) throw new Error(`暂存失败: ${stage.err}`);
    // 改动全被拦：不留空提交，也不推送
    if (stage.files.length === 0) {
      return { files: [], blocked: stage.blocked, pushed: false, prUrl: task.prUrl ?? undefined };
    }

    const files = stage.files;
    const base = repo.baseBranch ?? "main";
    const branch = task.branch ?? `pisa/${task.id}`;
    const title = `pisa: ${task.prompt.split("\n")[0]?.slice(0, 60) ?? task.id}`;

    const commit = commitStaged(workdir, `${title}\n\n任务: ${task.id}`, this.cfg.delivery.commitName, this.cfg.delivery.commitEmail);
    if (commit.code !== 0) throw new Error(`提交失败: ${commit.err || commit.out}`);

    const remote = repo.remote ?? remoteUrl(workdir);
    let pushed = false;

    if (this.cfg.delivery.push && remote) {
      // agent 能自己 git commit：分支上已有的提交同样会随推送上线，推前按同一规则核对整条分支
      const history = branchEntries(workdir, base);
      if (history.err) throw new Error(`读取分支历史失败: ${history.err}`);
      const leaked = history.entries.filter((paths) => paths.some(isSensitivePath)).flat();
      if (leaked.length > 0) throw new Error(`分支历史含敏感路径，已停止推送: ${leaked.join(", ")}`);
      const p = pushBranch(workdir, branch);
      if (p.code !== 0) throw new Error(`推送失败: ${p.err || p.out}`);
      pushed = true;
    }

    // 已有 PR：分支推送即更新 PR，不再新建
    if (task.prUrl) return { branch, prUrl: task.prUrl, files, pushed, blocked: stage.blocked };

    const ghReady = this.deps.hasGh ?? hasGh;
    let prUrl: string | undefined;
    if (this.cfg.delivery.pr && pushed && remote.includes("github.com") && ghReady()) {
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

    return { branch, prUrl, files, pushed, blocked: stage.blocked };
  }
}
