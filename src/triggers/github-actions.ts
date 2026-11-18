import { createHmac } from "node:crypto";
import type { GithubActionsTriggerConfig } from "../config";
import { safeEqual } from "../http";
import {
  commandText,
  TriggerError,
  type HttpTriggerRequest,
  type TriggerAdapter,
  type TriggerOutcome,
} from "./types";

/** 默认只对失败结论开单：成功事件开单等于噪音 */
const DEFAULT_CONCLUSIONS = ["failure", "timed_out"];

export interface GithubActionsPayload {
  event: string;
  delivery: string;
  body: Record<string, unknown>;
}

export interface GithubActionsOptions {
  config: GithubActionsTriggerConfig;
  /** 与 GitHub webhook secret 相同的值；为空时入口不可用 */
  secret: string;
  trigger: string;
  chatId: string;
  userId: string;
  /** 任务落到哪个 pisa 仓库别名 */
  repo?: string;
  now?: () => number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * GitHub Actions 入口：`POST /github/actions`。
 *
 * 签名是唯一鉴权：`X-Hub-Signature-256` 为正文的 HMAC-SHA256，密钥存环境变量。
 * 只把 `workflow_run` 的失败结论归一成任务，其余事件回执 200 但不建单。
 */
export class GithubActionsAdapter implements TriggerAdapter<HttpTriggerRequest, GithubActionsPayload> {
  readonly name = "github-actions";
  private readonly now: () => number;

  constructor(private readonly opts: GithubActionsOptions) {
    this.now = opts.now ?? Date.now;
  }

  async verify(req: HttpTriggerRequest): Promise<GithubActionsPayload> {
    if (req.method !== "POST") throw new TriggerError(405, "method not allowed");
    if (!this.opts.secret) throw new TriggerError(503, "github actions secret 未配置");

    const given = req.headers.get("x-hub-signature-256") ?? "";
    const expected = `sha256=${createHmac("sha256", this.opts.secret).update(req.body).digest("hex")}`;
    if (!given.startsWith("sha256=") || !safeEqual(given, expected)) {
      throw new TriggerError(401, "签名校验失败");
    }

    const event = req.headers.get("x-github-event") ?? "";
    const delivery = req.headers.get("x-github-delivery") ?? "";
    if (!event) throw new TriggerError(400, "缺少 X-GitHub-Event");
    if (!delivery) throw new TriggerError(400, "缺少 X-GitHub-Delivery");

    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      throw new TriggerError(400, "请求体不是合法 JSON");
    }
    const body = record(parsed);
    if (!body) throw new TriggerError(400, "请求体必须是 JSON 对象");
    return { event, delivery, body };
  }

  normalize(payload: GithubActionsPayload): TriggerOutcome | null {
    // ping 是 GitHub 配置 webhook 时的连通性探测
    if (payload.event === "ping") return null;
    if (payload.event !== "workflow_run") return null;

    const run = record(payload.body.workflow_run);
    const repo = record(payload.body.repository);
    if (!run || !repo) throw new TriggerError(400, "workflow_run 载荷缺少 workflow_run 或 repository");

    const repoName = str(repo.full_name);
    if (!repoName) throw new TriggerError(400, "载荷缺少 repository.full_name");
    const allowed = this.opts.config.repos ?? [];
    if (allowed.length > 0 && !allowed.includes(repoName)) {
      throw new TriggerError(403, `仓库 ${repoName} 不在白名单`);
    }

    const conclusion = str(run.conclusion);
    const conclusions = this.opts.config.conclusions ?? DEFAULT_CONCLUSIONS;
    if (!conclusions.includes(conclusion)) return null;

    const workflow = str(run.name) || str(run.path) || "(workflow)";
    const branch = str(run.head_branch) || "(unknown)";
    const url = str(run.html_url);
    const sender = record(payload.body.sender);
    const actor = str(sender?.login) || "github-actions";
    const dedupeKey = this.dedupeKey(payload);

    return {
      event: {
        dedupeKey,
        message: {
          eventId: dedupeKey,
          channel: "github-actions",
          chatId: this.opts.chatId,
          userId: this.opts.userId,
          actor,
          repo: this.opts.repo,
          isDirect: true,
          text: commandText(this.opts.trigger, `CI ${conclusion}：${repoName} · ${workflow} · 分支 ${branch}${url ? `\n${url}` : ""}`),
          threadKey: `github-actions:${repoName}:${branch}`,
          messageKey: dedupeKey,
          version: str(run.updated_at),
          receivedAt: this.now(),
        },
      },
    };
  }

  dedupeKey(payload: GithubActionsPayload): string {
    const run = record(payload.body.workflow_run);
    const id = run?.id;
    const repo = str(record(payload.body.repository)?.full_name);
    // 同一次 run 可能换投递 id 重发：按 run 自身 id 去重才真的不重复
    if (run && (typeof id === "number" || typeof id === "string")) {
      return `github-actions:${repo}:run:${String(id)}`;
    }
    return `github-actions:${payload.delivery}`;
  }
}
