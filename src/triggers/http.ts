import type { Config } from "../config";
import { MAX_BODY_BYTES } from "../http";
import type { IncomingMessage } from "../types";
import { FeishuAdapter } from "./feishu";
import { GithubActionsAdapter } from "./github-actions";
import { dispatch, TriggerError, type HttpTriggerRequest, type TriggerAdapter } from "./types";
import { WecomAdapter } from "./wecom";

export interface TriggersHttpDeps {
  cfg: Config;
  handle: (msg: IncomingMessage) => Promise<void>;
  /** 密钥查找面；测试注入假环境，生产走 process.env */
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export type HttpAdapter = TriggerAdapter<HttpTriggerRequest, unknown>;

/** 正文必须按原文交给验签，所以读字符串而不是 JSON */
async function readRaw(req: Request): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new TriggerError(413, "请求体过大");
  }
  const body = await req.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new TriggerError(413, "请求体过大");
  return body;
}

/**
 * 三个网络入口共用 127.0.0.1 上的一个端口：
 * `/github/actions`、`/feishu/event`、`/wecom/event`。
 * 未启用的入口返回 404，启用但缺少 chatId/userId 直接在装配时抛错。
 */
export function makeTriggersHandler(
  deps: TriggersHttpDeps,
): (req: Request) => Promise<Response> {
  const env = deps.env ?? process.env;
  const cfg = deps.cfg.triggers ?? {};
  const chatId = cfg.chatId ?? "";
  const userId = cfg.userId ?? "";
  const now = deps.now ?? Date.now;
  const routes = new Map<string, HttpAdapter>();

  const requireIdentity = (name: string) => {
    if (!chatId || !userId) {
      throw new Error(`triggers.${name} 已启用，但 triggers.chatId / triggers.userId 未配置`);
    }
  };

  if (cfg.githubActions?.enabled) {
    requireIdentity("githubActions");
    routes.set(
      "/github/actions",
      new GithubActionsAdapter({
        config: cfg.githubActions,
        secret: env[cfg.githubActions.secretEnv] ?? "",
        trigger: deps.cfg.trigger,
        chatId,
        userId,
        repo: cfg.repo,
        now,
      }),
    );
  }
  if (cfg.feishu?.enabled) {
    requireIdentity("feishu");
    routes.set(
      "/feishu/event",
      new FeishuAdapter({
        config: cfg.feishu,
        secret: env[cfg.feishu.secretEnv] ?? "",
        trigger: deps.cfg.trigger,
        chatId,
        userId,
        repo: cfg.repo,
        now,
      }),
    );
  }
  if (cfg.wecom?.enabled) {
    requireIdentity("wecom");
    routes.set(
      "/wecom/event",
      new WecomAdapter({
        config: cfg.wecom,
        token: env[cfg.wecom.tokenEnv] ?? "",
        aesKey: env[cfg.wecom.aesKeyEnv] ?? "",
        trigger: deps.cfg.trigger,
        chatId,
        userId,
        repo: cfg.repo,
        now,
      }),
    );
  }

  return async (req) => {
    const adapter = routes.get(new URL(req.url).pathname);
    if (!adapter) return new Response("not found", { status: 404 });
    try {
      const raw: HttpTriggerRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.method === "GET" ? "" : await readRaw(req),
      };
      const outcome = await dispatch(adapter, raw, deps.handle);
      if (outcome?.reply) {
        return new Response(outcome.reply.body, {
          status: 200,
          headers: { "content-type": outcome.reply.contentType },
        });
      }
      return Response.json({ ok: true });
    } catch (err) {
      if (!(err instanceof TriggerError)) throw err;
      return new Response(err.message, { status: err.status });
    }
  };
}
