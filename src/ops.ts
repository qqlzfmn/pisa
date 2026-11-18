import { githubRepos, type Config } from "./config";
import { parseCron } from "./scheduler";
import { daemonState, formatDuration } from "./status";
import type { Store } from "./store";

/** status / patrol 的退出码：0 正常、1 需重启、2 部件错误、3 待配置 */
export type OpsCode = 0 | 1 | 2 | 3;

export type OpsLevel = "ok" | "restart" | "component" | "config";

/** 一个可去重的问题：key 稳定，message 可以带随时间变化的细节 */
export interface OpsIssue {
  key: string;
  level: Exclude<OpsLevel, "ok">;
  message: string;
}

export interface OpsHealth {
  code: OpsCode;
  level: OpsLevel;
  issues: OpsIssue[];
}

export interface OpsDeps {
  cfg: Config;
  store: Store;
  /** 环境变量来源；测试注入，缺省 process.env */
  env?: Record<string, string | undefined>;
  now?: number;
}

/** 去重记录：当前已提醒过的问题 key，换行连接 */
export const OPS_META_KEY = "patrol:alerted";

/** 退出码与等级一一对应，数值大者优先 */
export const OPS_LEVEL_CODE: Record<OpsLevel, OpsCode> = { ok: 0, restart: 1, component: 2, config: 3 };

export const OPS_LEVEL_LABEL: Record<OpsLevel, string> = {
  ok: "正常",
  restart: "需重启",
  component: "部件错误",
  config: "待配置",
};

/**
 * 运维健康判定：配置 → 部件 → 进程，取最高级问题作为结论。
 * 只读配置、环境变量与心跳，不写库、不启动进程、不发消息。
 */
export function opsHealth(deps: OpsDeps): OpsHealth {
  const { cfg, store } = deps;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const issues: OpsIssue[] = [];
  const push = (key: string, level: OpsIssue["level"], message: string): void => {
    issues.push({ key, level, message });
  };

  if (cfg.repos.length === 0) push("config:repos", "config", "没有配置仓库（repos），无法派活");

  const telegram = cfg.channels.telegram;
  if (telegram?.enabled && !env[telegram.tokenEnv]) {
    push("component:telegram-token", "component", `Telegram 已启用但缺少环境变量 ${telegram.tokenEnv}`);
  }

  const webhook = cfg.webhook;
  if (webhook?.enabled) {
    if (!env[webhook.tokenEnv]) {
      push("component:webhook-token", "component", `Webhook 已启用但缺少环境变量 ${webhook.tokenEnv}`);
    }
    if (!webhook.chatId || !webhook.userId) {
      push("component:webhook-identity", "component", "Webhook 已启用但缺少 chatId/userId");
    }
  }

  const github = cfg.github;
  if (github?.enabled && githubRepos(github).length === 0) {
    push("component:github-repos", "component", "GitHub 已启用但没有完整的 repo/chatId/userId");
  }

  const schedules = cfg.schedules ?? [];
  if (schedules.length > 0 && (!cfg.scheduler?.chatId || !cfg.scheduler.userId)) {
    push("component:scheduler-identity", "component", "配置了 schedules 但缺少 scheduler.chatId/userId");
  }

  if (cfg.web?.enabled && !cfg.whitelist.users.includes(cfg.web.userId)) {
    push("component:web-user", "component", `web.userId=${cfg.web.userId} 不在 whitelist.users，页面派活会被拒绝`);
  }

  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const job of schedules) {
    if (seenIds.has(job.id)) {
      if (!duplicateIds.has(job.id)) {
        duplicateIds.add(job.id);
        push(`component:schedule-duplicate:${job.id}`, "component", `定时任务 id 重复：${job.id}`);
      }
      continue;
    }
    seenIds.add(job.id);
    if (!parseCron(job.cron)) {
      push(`component:schedule-cron:${job.id}`, "component", `定时任务 ${job.id} 的 cron 非法：${job.cron}`);
    }
  }

  const daemon = daemonState(store, now);
  if (!daemon.alive) {
    const beat = daemon.ageMs === null ? "无心跳记录" : `最后心跳 ${formatDuration(daemon.ageMs)} 前`;
    push("daemon:heartbeat", "restart", `守护进程未运行（${beat}）`);
  }

  let level: OpsLevel = "ok";
  for (const issue of issues) {
    if (OPS_LEVEL_CODE[issue.level] > OPS_LEVEL_CODE[level]) level = issue.level;
  }
  return { code: OPS_LEVEL_CODE[level], level, issues };
}

/** 看板与 `status` 文本的健康块 */
export function formatOpsHealth(health: OpsHealth): string {
  const head = health.level === "ok" ? "健康：正常" : `健康：${OPS_LEVEL_LABEL[health.level]}（退出码 ${health.code}）`;
  return [head, ...health.issues.map((i) => `- ${i.message}`)].join("\n");
}

/** 巡检告警：一次发完整现状，去重只决定发不发 */
export function formatOpsAlert(health: OpsHealth): string {
  const head = `pisa 巡检：${OPS_LEVEL_LABEL[health.level]}（退出码 ${health.code}）`;
  return [head, ...health.issues.map((i) => `- ${i.message}`)].join("\n");
}

export interface PatrolResult {
  health: OpsHealth;
  /** 本次新出现、需要提醒的问题 */
  fresh: OpsIssue[];
  /** 是否已通过回调投递；没有回调时为 false，由调用方自己输出 */
  delivered: boolean;
  /** 投递失败原因；失败时保留去重记录不变，下一轮重试 */
  error?: string;
}

/**
 * 一次巡检：只提醒新问题，问题消失后从记录里清除。
 * 先投递再写记录：投递失败时记录不变，下一轮重试。
 */
export async function patrolTick(
  deps: OpsDeps & { send?: (text: string) => Promise<void> | void },
): Promise<PatrolResult> {
  const health = opsHealth(deps);
  const previous = new Set((deps.store.getMeta(OPS_META_KEY) ?? "").split("\n").filter(Boolean));
  const fresh = health.issues.filter((i) => !previous.has(i.key));
  const keys = health.issues.map((i) => i.key).join("\n");

  if (fresh.length === 0) {
    deps.store.setMeta(OPS_META_KEY, keys);
    return { health, fresh, delivered: false };
  }

  let delivered = false;
  let error: string | undefined;
  if (deps.send) {
    try {
      await deps.send(formatOpsAlert(health));
      delivered = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  if (!error) deps.store.setMeta(OPS_META_KEY, keys);
  return { health, fresh, delivered, ...(error ? { error } : {}) };
}
