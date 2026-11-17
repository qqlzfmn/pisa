import type { Config } from "../config";
import type { IncomingMessage } from "../types";
import { FeishuTrigger } from "./feishu";
import { FileTrigger } from "./files";
import { GithubActionsTrigger } from "./github-actions";
import { TriggerHub } from "./hub";
import type { TriggerAdapter, TriggerSource } from "./types";

const DEFAULT_PORT = 8800;

export interface BuildTriggersOptions {
  cfg: Config;
  deliver: (m: IncomingMessage) => void | Promise<unknown>;
}

/**
 * 按配置装配事件入口。
 * 未启用 `triggers` 时返回 null，与没有这段配置时行为一致；
 * 某个来源缺凭据只告警并跳过该来源，不阻断进程启动。
 */
export function buildTriggers({ cfg, deliver }: BuildTriggersOptions): TriggerHub | null {
  const triggers = cfg.triggers;
  if (!triggers?.enabled) return null;

  const adapters: TriggerAdapter[] = [];
  const sources: TriggerSource[] = [];

  const actions = triggers.githubActions;
  if (actions?.enabled) {
    const secret = process.env[actions.secretEnv];
    if (!secret) console.error(`[pisa] GitHub Actions 入口已启用但缺少环境变量 ${actions.secretEnv}`);
    else adapters.push(new GithubActionsTrigger(actions, cfg.trigger, secret));
  }

  const feishu = triggers.feishu;
  if (feishu?.enabled) {
    const encryptKey = process.env[feishu.encryptKeyEnv];
    const verificationToken = feishu.verificationTokenEnv ? process.env[feishu.verificationTokenEnv] : undefined;
    if (!encryptKey) {
      console.error(`[pisa] 飞书入口已启用但缺少环境变量 ${feishu.encryptKeyEnv}，已跳过`);
    } else if (feishu.verificationTokenEnv && !verificationToken) {
      // 配了验证令牌却读不到：跳过来源而不是跳过校验，否则 URL 校验会被无条件放行
      console.error(`[pisa] 飞书入口已启用但缺少环境变量 ${feishu.verificationTokenEnv}，已跳过`);
    } else {
      adapters.push(new FeishuTrigger(feishu, cfg.trigger, encryptKey, verificationToken));
    }
  }

  const files = triggers.files;
  if (files?.enabled) sources.push(new FileTrigger(files, { trigger: cfg.trigger, deliver }));

  if (adapters.length === 0 && sources.length === 0) {
    console.error("[pisa] triggers 已启用但没有可用来源");
    return null;
  }
  return new TriggerHub({
    port: triggers.port ?? DEFAULT_PORT,
    host: triggers.host,
    adapters,
    sources,
    deliver,
  });
}

export type { TriggerAdapter, TriggerEvent, TriggerRequest, TriggerSource } from "./types";
export { FeishuTrigger } from "./feishu";
export { FileTrigger } from "./files";
export { GithubActionsTrigger } from "./github-actions";
export { TriggerHub } from "./hub";
