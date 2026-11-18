import { githubRepos, type Config } from "./config";
import { isGitRepo } from "./git";
import { daemonState, formatDuration } from "./status";
import type { Store } from "./store";
import { resolveToken } from "./token";

/** 健康结论：0 正常 / 1 需重启 / 2 部件错误 / 3 待配置 */
export type HealthExit = 0 | 1 | 2 | 3;

export const HEALTH_LABEL: Record<HealthExit, string> = {
  0: "正常",
  1: "需重启",
  2: "部件错误",
  3: "待配置",
};

export interface HealthIssue {
  code: Exclude<HealthExit, 0>;
  /** 问题实例的稳定标识：巡检按它判断「同一问题」 */
  key: string;
  message: string;
}

export interface HealthReport {
  exit: HealthExit;
  issues: HealthIssue[];
}

export interface HealthDeps {
  /** token 是否可得；测试注入用 */
  token?: (envName: string) => string | null;
  now?: () => number;
}

/**
 * 一次健康检查：配置 → 部件 → 守护进程，重的排前面。
 * 多个问题同时存在时 exit 取最严重的，问题按严重度从高到低列出。
 */
export function healthReport(cfg: Config, store: Store, deps: HealthDeps = {}): HealthReport {
  const token = deps.token ?? resolveToken;
  const now = deps.now ?? Date.now;
  const issues: HealthIssue[] = [];

  const telegram = cfg.channels.telegram;
  const webhook = cfg.webhook;
  const github = cfg.github;
  const web = cfg.web;
  const schedules = (cfg.schedules ?? []).filter((job) => job.enabled !== false);
  // 只有非 CLI 入口才会走白名单；纯 CLI 部署不受 whitelist 约束
  const remote = Boolean(telegram?.enabled || webhook?.enabled || github?.enabled || web?.enabled || schedules.length > 0);
  const ingress = Boolean(cfg.channels.cli || telegram?.enabled || webhook?.enabled || github?.enabled || web?.enabled);

  if (cfg.repos.length === 0) {
    issues.push({ code: 3, key: "config:repos-empty", message: "配置里没有仓库（repos 为空），任务无处执行" });
  } else {
    for (const repo of cfg.repos) {
      if (!isGitRepo(repo.path)) {
        issues.push({
          code: 3,
          key: `config:repo:${repo.alias}`,
          message: `仓库 ${repo.alias} 的路径不是 git 仓库：${repo.path}`,
        });
      }
    }
  }
  if (remote) {
    if (cfg.whitelist.users.length === 0) {
      issues.push({ code: 3, key: "config:users-empty", message: "whitelist.users 为空，聊天与 Web 入口的请求都会被拒绝" });
    }
    if (cfg.whitelist.repos.length === 0) {
      issues.push({ code: 3, key: "config:whitelist-repos-empty", message: "whitelist.repos 为空，所有远程入口的仓库都会被拒绝" });
    } else {
      for (const alias of cfg.whitelist.repos) {
        if (!cfg.repos.some((repo) => repo.alias === alias)) {
          issues.push({
            code: 3,
            key: `config:whitelist-repo:${alias}`,
            message: `whitelist.repos 里的 ${alias} 在 repos 中不存在`,
          });
        }
      }
    }
  }
  if (!ingress) {
    issues.push({
      code: 3,
      key: "config:no-ingress",
      message: "没有启用的入口：channels.cli 关闭，telegram、webhook、github、web 也都没开",
    });
  }
  if (telegram?.enabled && !token(telegram.tokenEnv)) {
    issues.push({
      code: 3,
      key: "config:telegram-token",
      message: `telegram 已启用，但取不到 ${telegram.tokenEnv}（环境变量或 ~/.pisa/telegram_token）`,
    });
  }
  if (webhook?.enabled && !token(webhook.tokenEnv)) {
    issues.push({
      code: 3,
      key: "config:webhook-token",
      message: `webhook 已启用，但取不到 ${webhook.tokenEnv}（环境变量或 ~/.pisa/webhook_token）`,
    });
  }
  if (github?.enabled && githubRepos(github).length === 0) {
    issues.push({
      code: 3,
      key: "config:github-repos",
      message: "github 已启用，但没有完整的仓库配置（repo/repos + chatId + userId）",
    });
  }
  if (schedules.length > 0 && !(cfg.scheduler?.chatId && cfg.scheduler?.userId)) {
    issues.push({
      code: 3,
      key: "config:scheduler",
      message: "配了定时任务，但 scheduler.chatId / userId 不全，到点不会开单",
    });
  }

  const failedEffects = store.failedEffectCount();
  if (failedEffects > 0) {
    issues.push({
      code: 2,
      key: "effects:failed",
      message: `${failedEffects} 条外部动作重试耗尽（push / PR / 评论），不会自行恢复`,
    });
  }

  const daemon = daemonState(store, now());
  if (!daemon.alive) {
    issues.push({
      code: 1,
      key: "daemon:down",
      message:
        daemon.ageMs === null
          ? "守护进程从未上报心跳，任务不会被执行"
          : `守护进程心跳已过期 ${formatDuration(daemon.ageMs)}，任务不会被执行`,
    });
  }

  issues.sort((a, b) => b.code - a.code || a.key.localeCompare(b.key));
  const exit = (issues[0]?.code ?? 0) as HealthExit;
  return { exit, issues };
}

/** 巡检提醒正文：结论、问题清单、去重口径 */
export function formatHealthAlert(report: HealthReport): string {
  const lines = [`pisa 巡检：${HEALTH_LABEL[report.exit]}（退出码 ${report.exit}）`];
  for (const issue of report.issues) lines.push(`- ${issue.message}`);
  lines.push("处理前不再重复提醒，恢复后自动清零。");
  return lines.join("\n");
}
