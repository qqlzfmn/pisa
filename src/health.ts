import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";

/** 0 正常 / 1 需重启 / 2 部件错误 / 3 待配置 */
export type HealthCode = 0 | 1 | 2 | 3;

/** 一个健康问题：key 稳定用于去重，message 供人读 */
export interface HealthProblem {
  key: string;
  message: string;
}

export interface HealthReport {
  code: HealthCode;
  problems: HealthProblem[];
  checkedAt: number;
}

export const HEALTH_LABEL: Record<HealthCode, string> = {
  0: "正常",
  1: "需重启",
  2: "部件错误",
  3: "待配置",
};

/** 守护进程每 30 秒写一次心跳；6 个周期没更新视为卡死或未运行 */
const HEARTBEAT_EVERY_MS = 30_000;
const HEARTBEAT_STALE_MS = HEARTBEAT_EVERY_MS * 6;

export function heartbeatPath(stateDir: string): string {
  return join(stateDir, "heartbeat");
}

export function alertStatePath(stateDir: string): string {
  return join(stateDir, "ops-alert.json");
}

/** 守护进程存活标记：启动即写一次，之后定时刷新；返回停止函数 */
export function startHeartbeat(stateDir: string): () => void {
  const file = heartbeatPath(stateDir);
  const touch = (): void => {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(file, String(Date.now()));
    } catch {
      // 心跳写失败不能拖垮守护进程，下一轮还会重试
    }
  };
  touch();
  const timer = setInterval(touch, HEARTBEAT_EVERY_MS);
  return () => clearInterval(timer);
}

function heartbeatAgeMs(stateDir: string): number | null {
  const file = heartbeatPath(stateDir);
  if (!existsSync(file)) return null;
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/** 只读打开，避免与守护进程抢写锁；能查表才算可用 */
function databaseError(path: string): string | null {
  try {
    const db = new Database(path, { readonly: true });
    try {
      db.query("SELECT COUNT(*) AS n FROM tasks").get();
    } finally {
      db.close();
    }
    return null;
  } catch (err) {
    return String((err as Error).message ?? err).slice(0, 200);
  }
}

export interface HealthDeps {
  cfg: Config;
  /** 配置文件绝对路径：缺文件说明还没配置 */
  configFile: string;
  /** 配置文件存在但无法解析：直接判待配置，其余检查没有可信输入 */
  configError?: string | null;
}

/**
 * 检查一次并给出退出码。三类问题分别对应 3 / 2 / 1，同时存在时取更严重的：
 * 配置不全（3）> 部件坏了（2）> 进程该重启（1）。
 */
export function inspect(deps: HealthDeps): HealthReport {
  const { cfg, configFile, configError } = deps;
  const now = Date.now();
  if (configError) {
    return {
      code: 3,
      problems: [{ key: "config-invalid", message: `配置文件无法解析：${configError}` }],
      checkedAt: now,
    };
  }
  const config: HealthProblem[] = [];
  const components: HealthProblem[] = [];
  const runner: HealthProblem[] = [];

  if (!existsSync(configFile)) config.push({ key: "config-missing", message: `找不到配置文件 ${configFile}` });
  if (cfg.repos.length === 0) config.push({ key: "repos-empty", message: "repos 为空，没有可交付的仓库" });
  for (const repo of cfg.repos) {
    if (!existsSync(repo.path)) {
      config.push({ key: `repo-missing:${repo.alias}`, message: `仓库 ${repo.alias} 的路径不存在：${repo.path}` });
    }
  }
  if (!cfg.channels.telegram?.enabled && !cfg.channels.cli) {
    config.push({ key: "channel-none", message: "没有启用任何通道" });
  }

  const telegram = cfg.channels.telegram;
  if (telegram?.enabled && !process.env[telegram.tokenEnv]) {
    components.push({ key: "telegram-token", message: `通道已启用但缺少环境变量 ${telegram.tokenEnv}` });
  }
  // 绝对路径直接看文件，裸命令走 PATH
  const command = cfg.worker.command;
  const commandFound = command.includes("/") ? existsSync(command) : Bun.which(command) !== null;
  if (!commandFound) {
    components.push({ key: `worker-missing:${command}`, message: `找不到 worker 命令 ${command}` });
  }

  const age = heartbeatAgeMs(cfg.stateDir);
  const alive = age !== null && age <= HEARTBEAT_STALE_MS;
  const dbPath = join(cfg.stateDir, "pisa.db");
  if (existsSync(dbPath)) {
    const err = databaseError(dbPath);
    if (err) components.push({ key: "db-unreadable", message: `任务库不可用：${err}` });
  } else if (alive) {
    components.push({ key: "db-missing", message: `心跳正常但任务库不存在：${dbPath}` });
  }
  if (!alive) {
    runner.push({
      key: "heartbeat-stale",
      message:
        age === null
          ? `没有心跳文件，守护进程未运行（${heartbeatPath(cfg.stateDir)}）`
          : `心跳已过期：${Math.round(age / 1000)}s 前（阈值 ${HEARTBEAT_STALE_MS / 1000}s）`,
    });
  }

  const code: HealthCode = config.length > 0 ? 3 : components.length > 0 ? 2 : runner.length > 0 ? 1 : 0;
  return { code, problems: [...config, ...components, ...runner], checkedAt: now };
}

export function formatReport(report: HealthReport): string {
  const head = `pisa 状态：${HEALTH_LABEL[report.code]}（退出码 ${report.code}）`;
  return [head, ...report.problems.map((p) => `- ${p.message}`)].join("\n");
}

/** 去重签名只看退出码与问题标识，明细里的时间、措辞变化不算新问题 */
export function alertSignature(report: HealthReport): string {
  return [String(report.code), ...report.problems.map((p) => p.key).sort()].join("|");
}

/**
 * 巡检是否需要说话：异常且与上次通知不同 → true 并记下；
 * 恢复正常 → 清空记录，下次再坏重新通知。记录落盘，跨进程有效。
 */
export function shouldSpeak(stateDir: string, report: HealthReport): boolean {
  const file = alertStatePath(stateDir);
  if (report.code === 0) {
    if (existsSync(file)) rmSync(file, { force: true });
    return false;
  }
  const signature = alertSignature(report);
  if (existsSync(file)) {
    try {
      const last = JSON.parse(readFileSync(file, "utf8")) as { signature?: string };
      if (last.signature === signature) return false;
    } catch {
      // 状态文件坏了就当没有记录，重新通知一次
    }
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ signature, at: Date.now() }));
  return true;
}
