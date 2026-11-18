import { createHash } from "node:crypto";
import type { Config } from "./config";
import { isGitRepo } from "./git";
import { parseCron } from "./scheduler";
import { daemonState, formatDuration, type HeartbeatSource } from "./status";
import type { Store } from "./store";
import type { IncomingMessage } from "./types";

/** 巡检间隔：一小时 */
export const OPS_CHECK_INTERVAL_MS = 3_600_000;

/** `pisa status` 的退出码；脚本据此分支，不要随意改数值 */
export const OPS_EXIT = { ok: 0, restart: 1, component: 2, config: 3 } as const;

export type OpsLevel = "config" | "restart" | "component";

const LEVEL_LABEL: Record<OpsLevel, string> = { config: "待配置", restart: "需重启", component: "部件错误" };

const LEVEL_HINT: Record<number, string> = {
  [OPS_EXIT.restart]: "处理：守护进程没有心跳，检查它是否在运行，必要时重启。",
  [OPS_EXIT.component]: "处理：按上面的部件错误逐项排查；恢复后巡检会自动清零。",
  [OPS_EXIT.config]: "处理：补齐配置或环境变量后重启守护进程。",
};

export interface OpsProblem {
  level: OpsLevel;
  /** 问题归属：配置段、部件名或 daemon */
  source: string;
  /** 稳定的静态描述，不含时间戳，用作去重签名 */
  detail: string;
}

export interface OpsReport {
  exitCode: number;
  /** 全部问题，不只最高优先级那一档 */
  problems: OpsProblem[];
}

/** 部件错误只需键值读写 */
export type HealthState = Pick<Store, "getMeta" | "setMeta" | "deleteMeta" | "metaByPrefix">;

const HEALTH_PREFIX = "health:";
const MAX_MESSAGE = 300;

/** 环境变量视图：测试传内存对象，生产用 process.env */
type Env = Record<string, string | undefined>;

const hasEnv = (env: Env, name: string | undefined): boolean => Boolean(name && env[name]?.trim());

interface ConfigProblem {
  source: string;
  detail: string;
}

/**
 * 「配置声明了、但前提不成立」的静态检查。
 * 只读配置与环境变量；仓库路径会跑一次 `git rev-parse`。
 */
export function configProblems(cfg: Config, env: Env = process.env): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const add = (source: string, detail: string): void => {
    problems.push({ source, detail });
  };

  if (cfg.repos.length === 0) add("repos", "没有任何仓库，任务无处落地");
  for (const repo of cfg.repos) {
    if (!isGitRepo(repo.path)) add(`repo:${repo.alias}`, `路径不是 git 仓库：${repo.path}`);
  }

  const telegram = cfg.channels.telegram;
  if (telegram?.enabled && !hasEnv(env, telegram.tokenEnv)) add("channels.telegram", `缺少环境变量 ${telegram.tokenEnv}`);
  if (cfg.webhook?.enabled && !hasEnv(env, cfg.webhook.tokenEnv)) add("webhook", `缺少环境变量 ${cfg.webhook.tokenEnv}`);

  if (cfg.web?.enabled && !cfg.whitelist.users.includes(cfg.web.userId)) {
    add("web.userId", `${cfg.web.userId} 不在 whitelist.users，页面派活会被拒绝`);
  }

  const triggers = cfg.triggers;
  if (triggers?.githubActions?.enabled && !hasEnv(env, triggers.githubActions.secretEnv)) {
    add("triggers.githubActions", `缺少环境变量 ${triggers.githubActions.secretEnv}`);
  }
  if (triggers?.feishu?.enabled && !hasEnv(env, triggers.feishu.secretEnv)) {
    add("triggers.feishu", `缺少环境变量 ${triggers.feishu.secretEnv}`);
  }
  if (triggers?.wecom?.enabled) {
    if (!hasEnv(env, triggers.wecom.tokenEnv)) add("triggers.wecom", `缺少环境变量 ${triggers.wecom.tokenEnv}`);
    if (!hasEnv(env, triggers.wecom.aesKeyEnv)) add("triggers.wecom", `缺少环境变量 ${triggers.wecom.aesKeyEnv}`);
  }
  if (triggers?.fileWatch?.enabled) {
    if (!triggers.chatId) add("triggers.fileWatch", "缺少 triggers.chatId");
    if (!triggers.userId) add("triggers.fileWatch", "缺少 triggers.userId");
  }

  const github = cfg.github;
  if (github?.enabled && !hasEnv(env, github.tokenEnv) && !hasEnv(env, "GH_TOKEN")) {
    add("github", `缺少环境变量 ${github.tokenEnv ?? "GH_TOKEN"}`);
  }

  const schedules = (cfg.schedules ?? []).filter((job) => job.enabled !== false);
  if (schedules.length > 0 && (!cfg.scheduler?.chatId || !cfg.scheduler?.userId)) add("scheduler", "有启用的定时任务，但缺少 scheduler.chatId / userId");
  for (const job of schedules) {
    if (!parseCron(job.cron)) add(`schedule:${job.id}`, `cron 表达式无法解析：${job.cron}`);
  }

  const remoteEntry =
    Boolean(telegram?.enabled) ||
    Boolean(cfg.web?.enabled) ||
    Boolean(cfg.webhook?.enabled) ||
    Boolean(triggers?.githubActions?.enabled) ||
    Boolean(triggers?.feishu?.enabled) ||
    Boolean(triggers?.wecom?.enabled) ||
    Boolean(triggers?.fileWatch?.enabled);
  if (remoteEntry && cfg.whitelist.users.length === 0) add("whitelist.users", "启用了远程入口，但白名单为空，所有请求都会被拒绝");

  if (cfg.ops?.enabled) {
    if (!cfg.ops.chatId) add("ops", "缺少 ops.chatId，巡检无法投递");
    if (!cfg.ops.userId) add("ops", "缺少 ops.userId，巡检无法投递");
  }
  return problems;
}

interface ComponentFailure {
  message: string;
  at: number;
}

/** 解析一条部件记录；损坏的行保留原文作为消息，不静默丢掉 */
function readFailure(raw: string): ComponentFailure {
  let value: unknown = null;
  try {
    value = JSON.parse(raw);
  } catch {
    // 不是 JSON：落到下面的原文
  }
  if (typeof value === "object" && value !== null && "message" in value && typeof value.message === "string") {
    const at = "at" in value && typeof value.at === "number" ? value.at : 0;
    return { message: value.message, at };
  }
  return { message: raw.slice(0, MAX_MESSAGE), at: 0 };
}

/**
 * 系统体检：退出码与问题列表同源。
 * 优先级 待配置 > 需重启 > 部件错误：配置缺项时重启只会再挂一次；进程没在跑时，上次运行留下的部件错误不是当前动作。
 */
export function checkOps(cfg: Config, store: HealthState & HeartbeatSource, env: Env = process.env, now = Date.now()): OpsReport {
  const problems: OpsProblem[] = configProblems(cfg, env).map((p) => ({ level: "config", ...p }));

  const daemon = daemonState(store, now);
  if (!daemon.alive) {
    const detail = daemon.lastBeat === null ? "没有心跳记录，守护进程未启动" : `心跳已停 ${formatDuration(daemon.ageMs ?? 0)}`;
    problems.push({ level: "restart", source: "daemon", detail });
  }

  for (const row of store.metaByPrefix(HEALTH_PREFIX)) {
    const failure = readFailure(row.value);
    problems.push({ level: "component", source: row.key.slice(HEALTH_PREFIX.length), detail: failure.message });
  }

  const exitCode = problems.some((p) => p.level === "config")
    ? OPS_EXIT.config
    : problems.some((p) => p.level === "restart")
      ? OPS_EXIT.restart
      : problems.some((p) => p.level === "component")
        ? OPS_EXIT.component
        : OPS_EXIT.ok;
  return { exitCode, problems };
}

/** 人读的问题列表；正常系统返回空串，调用方不必判空 */
export function formatOpsProblems(report: OpsReport): string {
  return report.problems.map((p) => `${LEVEL_LABEL[p.level]}：${p.source} ${p.detail}`).join("\n");
}

/**
 * 部件运行期错误的记账：出错写 `health:<部件>`，恢复删除。
 * 记录没有过期时间——不清除就一直是事实，「恢复后清零」由部件自己负责。
 */
export class ComponentHealth {
  constructor(private store: HealthState) {}

  /** 同一条消息不重写，避免每小时巡检都产生写事务 */
  fail(component: string, err: unknown): void {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_MESSAGE);
    const raw = this.store.getMeta(HEALTH_PREFIX + component);
    if (raw !== null && readFailure(raw).message === message) return;
    this.store.setMeta(HEALTH_PREFIX + component, JSON.stringify({ message, at: Date.now() } satisfies ComponentFailure));
  }

  ok(component: string): void {
    const key = HEALTH_PREFIX + component;
    if (this.store.getMeta(key) !== null) this.store.deleteMeta(key);
  }

  /** 新进程启动：上一轮运行的部件错误已过期，删掉后由部件重新记账 */
  reset(): void {
    for (const row of this.store.metaByPrefix(HEALTH_PREFIX)) this.store.deleteMeta(row.key);
  }
}

/** 部件记账接口：GithubWatcher 等只要 fail / ok 两个动作 */
export type HealthRecorder = Pick<ComponentHealth, "fail" | "ok">;

const OPS_KEY = "ops:alert";

interface AlertState {
  signature: string;
  at: number;
}

/** 签名 = 退出码 + 排序后的问题列表；恢复为 0 时不存在 */
function signatureOf(report: OpsReport): string {
  const problems = report.problems.map((p) => `${p.level}:${p.source}:${p.detail}`).sort();
  return [String(report.exitCode), ...problems].join("\n");
}

export interface OpsDeps {
  cfg: Config;
  store: HealthState & HeartbeatSource;
  enqueue: (m: IncomingMessage) => Promise<void> | void;
  env?: Env;
  now?: () => number;
  /** 覆盖间隔，仅供测试 */
  intervalMs?: number;
}

/**
 * 小时巡检：与 `pisa status` 同一份判定，只有问题签名变化才开单。
 * 修复动作交给 Router（排队、工作副本、回执都与其它入口一致）。
 */
export class OpsWatch {
  private timer: Timer | undefined;

  constructor(private deps: OpsDeps) {}

  start(): void {
    const ops = this.deps.cfg.ops;
    if (!ops?.enabled) return;
    if (!ops.chatId || !ops.userId) {
      console.warn("[pisa] ops 缺少 chatId / userId，巡检未启动（pisa status 会报待配置）");
      return;
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs());
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 一次巡检；返回本次结论，测试可直接调用 */
  tick(): OpsReport {
    const { cfg, store, env = process.env, now = Date.now } = this.deps;
    const report = checkOps(cfg, store, env, now());

    const ops = cfg.ops;
    if (!ops?.enabled || !ops.chatId || !ops.userId) {
      // 巡检关掉后旧签名不再有意义：重新启用时应当就当前问题提醒一次
      if (store.getMeta(OPS_KEY) !== null) store.deleteMeta(OPS_KEY);
      return report;
    }

    if (report.exitCode === OPS_EXIT.ok) {
      if (store.getMeta(OPS_KEY) !== null) store.deleteMeta(OPS_KEY);
      return report;
    }

    const signature = signatureOf(report);
    const raw = store.getMeta(OPS_KEY);
    if (raw !== null) {
      let previous: unknown = null;
      try {
        previous = JSON.parse(raw);
      } catch {
        // 记录损坏就当成没有记录，重新提醒一次
      }
      if (typeof previous === "object" && previous !== null && "signature" in previous && previous.signature === signature) return report;
    }

    const at = now();
    store.setMeta(OPS_KEY, JSON.stringify({ signature, at } satisfies AlertState));
    const text = [
      ops.prompt ?? "巡检发现 pisa 异常，请定位原因并修复。",
      "",
      formatOpsProblems(report),
      "",
      LEVEL_HINT[report.exitCode],
    ].join("\n");
    void Promise.resolve(
      this.deps.enqueue({
        eventId: `ops:${createHash("sha1").update(signature).digest("hex").slice(0, 12)}:${at}`,
        channel: "proactive",
        chatId: ops.chatId,
        userId: ops.userId,
        repo: ops.repo,
        isDirect: true,
        text,
      }),
    ).catch((err: unknown) => console.error(`[pisa] 巡检开单失败：${err instanceof Error ? err.message : err}`));
    return report;
  }

  private intervalMs(): number {
    const ops = this.deps.cfg.ops;
    const fromConfig = Math.max(60, ops?.intervalSec ?? OPS_CHECK_INTERVAL_MS / 1000) * 1000;
    return this.deps.intervalMs ?? fromConfig;
  }
}
