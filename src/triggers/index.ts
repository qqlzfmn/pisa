import type { Config } from "../config";
import { FeishuAdapter } from "./feishu";
import { GithubActionsAdapter } from "./github-actions";
import type { TriggerAdapter } from "./types";
import { WecomAdapter } from "./wecom";

/**
 * 按配置装配适配器：密钥只从环境变量读，缺变量就跳过该适配器并报错，
 * 与 webhook 的处理一致。返回空数组表示没有任何可用入口。
 */
export function buildTriggerAdapters(cfg: Config): TriggerAdapter[] {
  const entry = cfg.triggers;
  if (!entry) return [];
  const adapters: TriggerAdapter[] = [];

  const gh = entry.githubActions;
  if (gh?.enabled) {
    const secret = process.env[gh.secretEnv];
    if (!secret) console.error(`[pisa] github-actions 触发器缺少环境变量 ${gh.secretEnv}`);
    else {
      if (gh.repos.length === 0) console.error("[pisa] github-actions 触发器未配置 repos，所有回调都会被忽略");
      adapters.push(
        new GithubActionsAdapter({ secret, repos: gh.repos, workflows: gh.workflows, repo: gh.repo ?? entry.repo }),
      );
    }
  }

  const feishu = entry.feishu;
  if (feishu?.enabled) {
    const encryptKey = process.env[feishu.encryptKeyEnv];
    if (!encryptKey) console.error(`[pisa] feishu 触发器缺少环境变量 ${feishu.encryptKeyEnv}`);
    else {
      if (feishu.chats.length === 0) console.error("[pisa] feishu 触发器未配置 chats，所有消息都会被忽略");
      adapters.push(
        new FeishuAdapter({ encryptKey, chats: feishu.chats, users: feishu.users, repo: feishu.repo ?? entry.repo }),
      );
    }
  }

  const wecom = entry.wecom;
  if (wecom?.enabled) {
    const token = process.env[wecom.tokenEnv];
    const aesKey = process.env[wecom.aesKeyEnv];
    if (!token) console.error(`[pisa] wecom 触发器缺少环境变量 ${wecom.tokenEnv}`);
    else if (!aesKey) console.error(`[pisa] wecom 触发器缺少环境变量 ${wecom.aesKeyEnv}`);
    else {
      if (wecom.users.length === 0) console.error("[pisa] wecom 触发器未配置 users，所有消息都会被忽略");
      adapters.push(
        new WecomAdapter({ token, aesKey, corpId: wecom.corpId, users: wecom.users, repo: wecom.repo ?? entry.repo }),
      );
    }
  }

  return adapters;
}
