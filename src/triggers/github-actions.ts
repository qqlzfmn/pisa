import { createHmac } from "node:crypto";
import {
  BaseTriggerAdapter,
  equalHex,
  nonEmptyString,
  parseJsonObject,
  type TriggerOutcome,
  type TriggerRequest,
} from "./types";

export interface GithubActionsOptions {
  /** GitHub webhook secret：平台用它算 X-Hub-Signature-256 */
  secret: string;
  /** 允许的仓库（owner/repo）；空数组即全部忽略 */
  repos: string[];
  /** 允许的 workflow 名；缺省全部 */
  workflows?: string[];
  /** 任务归属仓库 alias；缺省时 Router 用默认仓库 */
  repo?: string;
}

interface WorkflowRunPayload {
  action?: unknown;
  repository?: { full_name?: unknown };
  workflow_run?: {
    id?: unknown;
    name?: unknown;
    conclusion?: unknown;
    head_branch?: unknown;
    html_url?: unknown;
    run_attempt?: unknown;
    updated_at?: unknown;
  };
  sender?: { login?: unknown };
}

/** GitHub Actions `workflow_run` 回调：CI 失败时开一次分诊任务 */
export class GithubActionsAdapter extends BaseTriggerAdapter {
  readonly name = "github-actions";
  private readonly options: GithubActionsOptions;

  constructor(options: GithubActionsOptions) {
    super();
    this.options = options;
  }

  verify(req: TriggerRequest): string | null {
    const given = req.headers.get("x-hub-signature-256");
    if (!given) return "缺少 X-Hub-Signature-256";
    const expected = `sha256=${createHmac("sha256", this.options.secret).update(req.body).digest("hex")}`;
    return equalHex(expected, given) ? null : "签名不匹配";
  }

  normalize(req: TriggerRequest): TriggerOutcome {
    const event = req.headers.get("x-github-event");
    if (event !== "workflow_run") return { kind: "ignore", reason: `事件 ${event ?? "(空)"} 不处理` };
    const payload = parseJsonObject(req.body) as WorkflowRunPayload | null;
    if (!payload) return { kind: "reject", status: 400, reason: "载荷不是 JSON 对象" };
    const repo = nonEmptyString(payload.repository?.full_name);
    if (!repo) return { kind: "reject", status: 400, reason: "载荷缺少 repository.full_name" };
    if (!this.options.repos.includes(repo)) return { kind: "ignore", reason: `仓库 ${repo} 不在白名单` };
    const run = payload.workflow_run;
    if (payload.action !== "completed" || !run) return { kind: "ignore", reason: `动作 ${String(payload.action)} 不处理` };
    if (typeof run.id !== "number" || !Number.isInteger(run.id)) {
      return { kind: "reject", status: 400, reason: "载荷缺少 workflow_run.id" };
    }
    const conclusion = nonEmptyString(run.conclusion);
    if (conclusion !== "failure") return { kind: "ignore", reason: `结论 ${conclusion ?? "(空)"} 不是 failure` };
    const name = nonEmptyString(run.name) ?? "workflow";
    if (this.options.workflows?.length && !this.options.workflows.includes(name)) {
      return { kind: "ignore", reason: `workflow ${name} 不在白名单` };
    }
    // 同一次 run 的重跑是不同的尝试，各自开单
    const attempt = typeof run.run_attempt === "number" && Number.isInteger(run.run_attempt) ? run.run_attempt : 1;
    const branch = nonEmptyString(run.head_branch) ?? "(unknown)";
    const url = nonEmptyString(run.html_url) ?? "";
    const updated = typeof run.updated_at === "string" ? Date.parse(run.updated_at) : Number.NaN;
    const text = [
      `CI 失败：${name}（第 ${attempt} 次尝试）`,
      `仓库：${repo}`,
      `分支：${branch}`,
      url ? `详情：${url}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      kind: "event",
      repo: this.options.repo,
      event: {
        threadKey: `github-actions:${repo}:run:${run.id}`,
        messageKey: `run:${run.id}:${attempt}`,
        version: "",
        actor: nonEmptyString(payload.sender?.login) ?? "github-actions",
        text,
        at: Number.isFinite(updated) ? updated : Date.now(),
      },
    };
  }
}
