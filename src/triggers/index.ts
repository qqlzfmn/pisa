import { DEFAULT_TRIGGERS_PORT, type Config } from "../config";
import type { IncomingMessage } from "../types";
import { FileWatchAdapter } from "./file-watch";
import { makeTriggersHandler } from "./http";

export { FeishuAdapter, feishuSignature } from "./feishu";
export { FileWatchAdapter } from "./file-watch";
export { GithubActionsAdapter } from "./github-actions";
export { makeTriggersHandler } from "./http";
export {
  commandText,
  dispatch,
  TriggerError,
  type HttpTriggerRequest,
  type TriggerAdapter,
  type TriggerOutcome,
} from "./types";
export { WecomAdapter, wecomSignature } from "./wecom";

export interface TriggersDeps {
  cfg: Config;
  handle: (msg: IncomingMessage) => Promise<void>;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export interface TriggersRuntime {
  stop(): void;
}

/**
 * 启动触发适配层：网络入口与文件监听各自按配置启用，未配置时返回 null。
 *
 * 与 webhook、Web 控制台一样只监听 127.0.0.1：外部事件由反向代理或内网转发进来。
 */
export function startTriggers(deps: TriggersDeps): TriggersRuntime | null {
  const cfg = deps.cfg.triggers;
  if (!cfg) return null;

  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const stops: Array<() => void> = [];

  try {
    const httpEnabled =
      cfg.http?.enabled ??
      Boolean(cfg.githubActions?.enabled || cfg.feishu?.enabled || cfg.wecom?.enabled);
    if (httpEnabled) {
      const server = Bun.serve({
        port: cfg.http?.port ?? DEFAULT_TRIGGERS_PORT,
        hostname: "127.0.0.1",
        fetch: makeTriggersHandler({ cfg: deps.cfg, handle: deps.handle, env, now }),
      });
      stops.push(() => server.stop(true));
    }

    if (cfg.fileWatch?.enabled) {
      if (!cfg.chatId || !cfg.userId) {
        throw new Error("triggers.fileWatch 已启用，但 triggers.chatId / triggers.userId 未配置");
      }
      const watcher = new FileWatchAdapter({
        config: cfg.fileWatch,
        trigger: deps.cfg.trigger,
        chatId: cfg.chatId,
        userId: cfg.userId,
        repo: cfg.repo,
        now,
      });
      watcher.start(deps.handle);
      stops.push(() => watcher.stop());
    }
  } catch (err) {
    // 启动到一半失败就把已经开起来的部分关掉，不留半套监听
    for (const stop of stops.splice(0)) stop();
    throw err;
  }

  if (stops.length === 0) return null;
  return {
    stop() {
      for (const stop of stops.splice(0)) stop();
    },
  };
}
