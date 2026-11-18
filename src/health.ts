import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { loadConfig, type Config } from "./config";
import type { Store } from "./store";
import { isGitRepo } from "./git";

/** 健康结论的退出码：数值越大越需要人工先处理 */
export type HealthCode = 0 | 1 | 2 | 3;

export interface HealthIssue {
  code: Exclude<HealthCode, 0>;
  /** restart=改了配置要重启；component=部件坏了；config=还没配好 */
  kind: "restart" | "component" | "config";
  message: string;
}

export interface Health {
  code: HealthCode;
  issues: HealthIssue[];
}

/** 守护进程启动时记录的配置指纹；与磁盘不一致就是要重启 */
export const CONFIG_HASH_KEY = "config.hash";

/** 配置指纹：同一份配置在不同进程里得到同一个值，用于发现「改了配置但没重启」 */
export function configHash(cfg: Config): string {
  const { configPath: _ignored, ...rest } = cfg;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

/** 健康检查以磁盘上的配置为准：脚本修完配置后应当看到「需重启」而不是旧的通过结论 */
function currentConfig(cfg: Config): { cfg: Config; error: string | null } {
  if (!cfg.configPath) return { cfg, error: null };
  try {
    return { cfg: loadConfig(cfg.configPath), error: null };
  } catch (err) {
    return { cfg, error: err instanceof Error ? err.message : String(err) };
  }
}

function commandExists(command: string): boolean {
  if (command.includes("/")) return existsSync(command);
  return Bun.which(command) !== null;
}

/**
 * 本机就绪检查：配置、部件、重启三类问题各给一条可执行的结论。
 * 只看确定的事实（文件、git 仓库、环境变量），不猜进程是否卡住。
 */
export function healthOf(cfg: Config, store: Store, env: Record<string, string | undefined> = process.env): Health {
  const current = currentConfig(cfg);
  const issues: HealthIssue[] = [];
  const add = (code: HealthIssue["code"], kind: HealthIssue["kind"], message: string): void => {
    issues.push({ code, kind, message });
  };

  if (current.error) {
    add(3, "config", `配置文件无法加载：${current.error}`);
  } else {
    const applied = store.getMeta(CONFIG_HASH_KEY);
    if (applied && applied !== configHash(current.cfg)) {
      add(1, "restart", "配置文件已变更，重启守护进程后生效");
    }
  }

  const active = current.cfg;
  for (const repo of active.repos) {
    if (!isGitRepo(repo.path)) add(2, "component", `仓库 ${repo.alias} 的路径不是 git 仓库：${repo.path}`);
  }
  if (!commandExists(active.worker.command)) {
    add(2, "component", `Worker 命令不可用：${active.worker.command}`);
  }

  if (active.repos.length === 0) add(3, "config", "没有配置仓库（repos）");
  if (active.whitelist.users.length === 0) add(3, "config", "whitelist.users 为空，所有请求都会被拒绝");
  if (active.web?.enabled) {
    if (!env[active.web.tokenEnv]?.trim()) {
      add(3, "config", `web 已启用但未设置 ${active.web.tokenEnv}，管理接口无法鉴权`);
    }
    if (!active.whitelist.users.includes(active.web.userId)) {
      add(3, "config", `web.userId=${active.web.userId} 不在 whitelist.users，页面派活会被拒绝`);
    }
  }
  const telegram = active.channels.telegram;
  if (telegram?.enabled && !env[telegram.tokenEnv]?.trim()) {
    add(3, "config", `telegram 已启用但未设置 ${telegram.tokenEnv}`);
  }
  if (active.github?.enabled && active.github.tokenEnv && !env[active.github.tokenEnv]?.trim()) {
    add(3, "config", `github 已启用但未设置 ${active.github.tokenEnv}`);
  }
  if ((active.schedules?.length ?? 0) > 0 && (!active.scheduler?.chatId || !active.scheduler?.userId)) {
    add(3, "config", "配置了 schedules 但缺少 scheduler 身份，定时任务不会生效");
  }

  const code = issues.reduce<HealthCode>((worst, issue) => (issue.code > worst ? issue.code : worst), 0);
  return { code, issues };
}

export const HEALTH_LABEL: Record<HealthCode, string> = {
  0: "正常",
  1: "需重启",
  2: "部件错误",
  3: "待配置",
};
