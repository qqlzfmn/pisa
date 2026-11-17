import type { GithubActionsTriggerConfig } from "../config";
import type { IncomingMessage } from "../types";
import type { NormalizeResult, TriggerAdapter, TriggerReply, TriggerRequest, TriggerVerdict } from "./types";
import { num, parseJsonObject, str, verifyGithubSignature } from "./verify";

const DEFAULT_CONCLUSIONS = ["failure"];
const DEFAULT_PROMPT = "定位失败原因并修复。";

/**
 * GitHub Actions 的 workflow_run 完成事件。
 * 只接结论命中白名单的运行；`repos` / `branches` 非空时按全名与分支再过一层。
 * 去重键带 run_attempt：重跑是新事件，同一 attempt 重复投递只建一个任务。
 */
export class GithubActionsTrigger implements TriggerAdapter {
  readonly name = "github-actions";
  readonly path = "github-actions";

  constructor(
    private readonly cfg: GithubActionsTriggerConfig,
    private readonly trigger: string,
    private readonly secret: string,
  ) {}

  handshake(): TriggerReply | null {
    return null;
  }

  verify(req: TriggerRequest): TriggerVerdict {
    if (!verifyGithubSignature(this.secret, req.body, req.headers["x-hub-signature-256"])) {
      return { ok: false, status: 403, error: "signature mismatch" };
    }
    return { ok: true };
  }

  normalize(req: TriggerRequest): NormalizeResult {
    const payload = parseJsonObject(req.body);
    if (!payload) return { ok: false, status: 400, error: "invalid json" };

    // ping 与其它事件是合法投递，只是与本功能无关
    if (req.headers["x-github-event"] !== "workflow_run") return { ok: true, events: [] };
    if (str(payload, "action") !== "completed") return { ok: true, events: [] };

    const repo = str(payload, "repository", "full_name");
    const runId = num(payload, "workflow_run", "id");
    if (!repo || runId === undefined) return { ok: false, status: 400, error: "missing workflow_run" };

    const conclusion = str(payload, "workflow_run", "conclusion");
    const conclusions = this.cfg.conclusions ?? DEFAULT_CONCLUSIONS;
    if (!conclusion || !conclusions.includes(conclusion)) return { ok: true, events: [] };

    const branch = str(payload, "workflow_run", "head_branch");
    if (this.cfg.repos?.length && !this.cfg.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) {
      return { ok: true, events: [] };
    }
    if (this.cfg.branches?.length && (!branch || !this.cfg.branches.includes(branch))) {
      return { ok: true, events: [] };
    }

    const attempt = num(payload, "workflow_run", "run_attempt") ?? 1;
    const message: IncomingMessage = {
      eventId: `github-actions:${repo}:${runId}:${attempt}`,
      channel: this.name,
      chatId: this.cfg.chatId,
      userId: this.cfg.userId,
      text: `${this.trigger} ${this.body(payload, repo, conclusion, branch)}`,
      repo: this.cfg.repo,
      isDirect: true,
    };
    return { ok: true, events: [{ dedupeKey: message.eventId, message }] };
  }

  private body(payload: Record<string, unknown>, repo: string, conclusion: string, branch?: string): string {
    const workflow = str(payload, "workflow_run", "name") ?? "workflow";
    const sha = str(payload, "workflow_run", "head_sha")?.slice(0, 7);
    const url = str(payload, "workflow_run", "html_url");
    const meta: string[] = [`分支: ${branch ?? "(unknown)"}`];
    if (url) meta.push(`运行: ${url}`);
    if (sha) meta.push(`提交: ${sha}`);
    return [`CI ${conclusion} · ${repo} · ${workflow}`, ...meta, "", this.cfg.prompt ?? DEFAULT_PROMPT].join("\n");
  }
}
