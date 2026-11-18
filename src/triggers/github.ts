import { createHash, createHmac } from "node:crypto";
import type {
  TriggerAdapter,
  TriggerOutcome,
  TriggerPayload,
  TriggerRequest,
  TriggerVerdict,
} from "./types";
import { isRecord, num, safeEqual, text } from "./util";

export interface GithubActionsOptions {
  /** webhook secret，必填；空值在构造时直接失败，避免静默放行 */
  secret: string;
  chatId: string;
  userId: string;
  repo?: string;
  /** 仓库白名单，形如 owner/name；空表示不限制 */
  repos?: string[];
  /** 订阅的 X-GitHub-Event，默认只收 workflow_run */
  events?: string[];
  /** 默认只把失败的运行变成任务 */
  failedOnly?: boolean;
  prompt?: string;
}

const DEFAULT_EVENTS = ["workflow_run"];
const FAILED_CONCLUSIONS: Record<string, true> = {
  failure: true,
  timed_out: true,
  startup_failure: true,
};

export class GithubActionsTrigger implements TriggerAdapter {
  readonly name = "github-actions";
  private readonly events: Set<string>;

  constructor(private readonly options: GithubActionsOptions) {
    if (options.secret.trim() === "") throw new Error("githubActions.secretEnv 对应的环境变量为空");
    this.events = new Set(options.events ?? DEFAULT_EVENTS);
  }

  verify(req: TriggerRequest): TriggerVerdict {
    if (req.method !== "POST") return { ok: false, status: 405, reason: "只接受 POST" };
    const signature = req.headers.get("x-hub-signature-256");
    if (!signature) return { ok: false, status: 401, reason: "缺少 X-Hub-Signature-256" };
    const expected =
      "sha256=" + createHmac("sha256", this.options.secret).update(req.body, "utf8").digest("hex");
    if (!safeEqual(signature, expected)) return { ok: false, status: 401, reason: "签名不匹配" };
    return { ok: true };
  }

  normalize(req: TriggerRequest): TriggerOutcome {
    const event = text(req.headers.get("x-github-event"));
    if (!event) return { kind: "reject", status: 400, reason: "缺少 X-GitHub-Event" };
    if (!this.events.has(event)) return { kind: "ignore", reason: `未订阅事件 ${event}` };

    let body: unknown;
    try {
      body = JSON.parse(req.body);
    } catch {
      return { kind: "reject", status: 400, reason: "载荷不是合法 JSON" };
    }
    if (!isRecord(body)) return { kind: "reject", status: 400, reason: "载荷不是 JSON 对象" };

    const repository = isRecord(body.repository) ? body.repository : {};
    const repo = text(repository.full_name) ?? text(repository.name);
    if (!repo) return { kind: "reject", status: 400, reason: "载荷缺少仓库标识" };
    if (this.options.repos?.length && !this.options.repos.includes(repo)) {
      return { kind: "ignore", reason: `仓库 ${repo} 不在白名单` };
    }

    if (event !== "workflow_run") {
      const action = text(body.action);
      const ref = text(body.ref) ?? text(body.ref_name);
      const delivery =
        text(req.headers.get("x-github-delivery")) ??
        createHash("sha256").update(req.body, "utf8").digest("hex");
      const summary = [repo, ref, action].filter((part) => part).join(" · ");
      return {
        kind: "event",
        payload: this.payload(delivery, this.options.prompt ?? `GitHub Actions ${event}：${summary}`),
      };
    }

    const run = isRecord(body.workflow_run) ? body.workflow_run : undefined;
    if (!run) return { kind: "reject", status: 400, reason: "workflow_run 载荷缺少 workflow_run" };
    const action = text(body.action);
    if (action !== "completed") return { kind: "ignore", reason: `运行未完成：${action ?? "unknown"}` };

    const conclusion = text(run.conclusion) ?? "unknown";
    if (this.options.failedOnly !== false && FAILED_CONCLUSIONS[conclusion] !== true) {
      return { kind: "ignore", reason: `运行结论 ${conclusion} 不是失败` };
    }
    const runId = num(run.id);
    if (runId === undefined) return { kind: "reject", status: 400, reason: "workflow_run 缺少 id" };

    const attempt = num(run.run_attempt) ?? 1;
    const workflow = text(run.name) ?? "(未命名 workflow)";
    const branch = text(run.head_branch) ?? "?";
    const runNumber = num(run.run_number);
    const url = text(run.html_url);
    const headline = conclusion === "success" ? "完成" : "失败";
    const lines = [
      `GitHub Actions ${headline}：${repo} · ${workflow}`,
      `分支 ${branch} · 第 ${runNumber ?? runId} 次运行（attempt ${attempt}） · ${conclusion}`,
    ];
    if (url) lines.push(url);

    return {
      kind: "event",
      payload: this.payload(`${repo}:${runId}:${attempt}`, this.options.prompt ?? lines.join("\n")),
    };
  }

  dedupeKey(payload: TriggerPayload): string {
    return `${this.name}:${payload.externalId}`;
  }

  private payload(externalId: string, text: string): TriggerPayload {
    const payload: TriggerPayload = {
      externalId,
      text,
      chatId: this.options.chatId,
      userId: this.options.userId,
    };
    if (this.options.repo) payload.repo = this.options.repo;
    return payload;
  }
}
