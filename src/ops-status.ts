import type { Config } from "./config";
import type { Store } from "./store";
import { daemonState, formatDuration } from "./status";

/** status 的生命周期退出码：0 正常、1 需重启、2 部件错误、3 待配置 */
export const OPS_EXIT = { ok: 0, restart: 1, component: 2, setup: 3 } as const;
export type OpsExitCode = (typeof OPS_EXIT)[keyof typeof OPS_EXIT];

export const OPS_EXIT_LABEL: Record<OpsExitCode, string> = {
  0: "正常",
  1: "需重启",
  2: "部件错误",
  3: "待配置",
};

/** 单条异常：code 决定退出码，key 是去重身份，detail 是给人看的说明 */
export interface OpsIssue {
  code: Exclude<OpsExitCode, 0>;
  key: string;
  detail: string;
}

export interface OpsStatus {
  exitCode: OpsExitCode;
  label: string;
  issues: OpsIssue[];
}

/** failed effect 明细最多取这么多条；更多时由巡检消息说明还有几条 */
const FAILED_EFFECT_LIMIT = 20;

/** 同一条状态可以命中多项；退出码按「下一步该做什么」取最高优先级 */
function pickExit(issues: readonly OpsIssue[]): OpsExitCode {
  if (issues.some((i) => i.code === OPS_EXIT.setup)) return OPS_EXIT.setup;
  if (issues.some((i) => i.code === OPS_EXIT.component)) return OPS_EXIT.component;
  if (issues.length > 0) return OPS_EXIT.restart;
  return OPS_EXIT.ok;
}

/** CLI 与巡检共用的状态判定：只读配置、任务库与 outbox */
export function evaluateOpsStatus(cfg: Config, store: Store, now = Date.now()): OpsStatus {
  const issues: OpsIssue[] = [];

  if (cfg.repos.length === 0) {
    issues.push({ code: OPS_EXIT.setup, key: "config:repos", detail: "配置里没有仓库（repos 为空），先补 pisa.config.json" });
  }

  for (const row of store.failedEffects(FAILED_EFFECT_LIMIT)) {
    const reason = row.lastError ? `：${row.lastError}` : "";
    issues.push({
      code: OPS_EXIT.component,
      key: `effect:${row.kind}:${row.key}`,
      detail: `外部动作 ${row.kind}:${row.key} 重试 ${row.attempts} 次后失败${reason}`,
    });
  }

  const daemon = daemonState(store, now);
  if (!daemon.alive) {
    issues.push({
      code: OPS_EXIT.restart,
      key: "daemon:heartbeat",
      detail:
        daemon.ageMs === null
          ? "守护进程没有心跳记录；启动或重启 pisa"
          : `守护进程最后心跳 ${formatDuration(daemon.ageMs)} 前；重启 pisa`,
    });
  }

  const exitCode = pickExit(issues);
  return { exitCode, label: OPS_EXIT_LABEL[exitCode], issues };
}

/** 异常明细的文本行：CLI stderr 与巡检消息共用 */
export function formatOpsIssues(issues: readonly OpsIssue[], limit = 5): string[] {
  const lines = issues.slice(0, limit).map((i) => `- ${i.detail}`);
  if (issues.length > limit) lines.push(`- 另有 ${issues.length - limit} 项未展开`);
  return lines;
}
