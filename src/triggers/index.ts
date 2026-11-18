import type { Config } from "../config";
import { FeishuTrigger } from "./feishu";
import { GithubActionsTrigger } from "./github";
import type { TriggerAdapter } from "./types";
import { WecomTrigger } from "./wecom";

export { createTriggerHandler, startTriggerServer, type TriggerHandlerDeps, type TriggerServer } from "./server";

export interface TriggerSetup {
  adapters: TriggerAdapter[];
  /** 配置开启但凭据缺失的来源；只在启动时提示，不阻断其它入口 */
  warnings: string[];
}

/**
 * 从配置与环境变量装配适配器。凭据只认环境变量，配置里只写变量名，
 * 与 telegram/github token 的既有做法一致。
 */
export function createTriggerAdapters(
  cfg: Config,
  env: Record<string, string | undefined> = process.env,
): TriggerSetup {
  const adapters: TriggerAdapter[] = [];
  const warnings: string[] = [];
  const triggers = cfg.triggers;
  if (!triggers?.enabled) return { adapters, warnings };

  const githubActions = triggers.githubActions;
  if (githubActions?.enabled) {
    const secret = envValue(env, githubActions.secretEnv);
    if (!secret) {
      warnings.push(`triggers.githubActions 已启用，但环境变量 ${githubActions.secretEnv} 为空`);
    } else if (!githubActions.chatId || !githubActions.userId) {
      warnings.push("triggers.githubActions 缺少 chatId 或 userId");
    } else {
      adapters.push(
        new GithubActionsTrigger({
          secret,
          chatId: githubActions.chatId,
          userId: githubActions.userId,
          repo: githubActions.repo,
          repos: githubActions.repos,
          events: githubActions.events,
          failedOnly: githubActions.failedOnly,
          prompt: githubActions.prompt,
        }),
      );
    }
  }

  const feishu = triggers.feishu;
  if (feishu?.enabled) {
    const verificationToken = envValue(env, feishu.verificationTokenEnv);
    const encryptKey = envValue(env, feishu.encryptKeyEnv);
    if (!verificationToken && !encryptKey) {
      warnings.push("triggers.feishu 已启用，但 Verification Token 与 Encrypt Key 都未设置");
    } else if (!feishu.chatId || !feishu.userId) {
      warnings.push("triggers.feishu 缺少 chatId 或 userId");
    } else {
      adapters.push(
        new FeishuTrigger({
          verificationToken,
          encryptKey,
          chatId: feishu.chatId,
          userId: feishu.userId,
          repo: feishu.repo,
          chats: feishu.chats,
          users: feishu.users,
          trigger: cfg.trigger,
        }),
      );
    }
  }

  const wecom = triggers.wecom;
  if (wecom?.enabled) {
    const token = envValue(env, wecom.tokenEnv);
    const aesKey = envValue(env, wecom.aesKeyEnv);
    if (!token || !aesKey) {
      warnings.push("triggers.wecom 已启用，但 Token 或 EncodingAESKey 未设置");
    } else if (!wecom.chatId || !wecom.userId || !wecom.corpId) {
      warnings.push("triggers.wecom 缺少 chatId、userId 或 corpId");
    } else {
      adapters.push(
        new WecomTrigger({
          token,
          aesKey,
          corpId: wecom.corpId,
          chatId: wecom.chatId,
          userId: wecom.userId,
          repo: wecom.repo,
          users: wecom.users,
        }),
      );
    }
  }

  return { adapters, warnings };
}

function envValue(env: Record<string, string | undefined>, name?: string): string | undefined {
  if (!name) return undefined;
  const value = env[name]?.trim();
  return value ? value : undefined;
}
