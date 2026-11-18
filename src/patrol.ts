import { formatHealthAlert, type HealthReport } from "./health";
import type { Store } from "./store";

/** meta 键：上一轮已提醒过的问题集合；恢复健康时删除 */
export const PATROL_SIGNATURE_KEY = "patrol:signature";

export interface PatrolResult {
  /** 本轮是否发出了提醒 */
  alerted: boolean;
  /** 是否因与上轮同一组问题而保持静默 */
  deduped: boolean;
}

/**
 * 一轮巡检：正常时清掉签名并静默；问题集合变化才提醒，
 * 提醒之后才写签名，因此投递失败不会吞掉下一次机会。
 */
export async function patrol(
  store: Store,
  report: HealthReport,
  notify: (text: string) => Promise<void> | void,
): Promise<PatrolResult> {
  if (report.exit === 0) {
    store.deleteMeta(PATROL_SIGNATURE_KEY);
    return { alerted: false, deduped: false };
  }
  const signature = report.issues.map((issue) => issue.key).sort().join("|");
  if (store.getMeta(PATROL_SIGNATURE_KEY) === signature) return { alerted: false, deduped: true };
  await notify(formatHealthAlert(report));
  store.setMeta(PATROL_SIGNATURE_KEY, signature);
  return { alerted: true, deduped: false };
}
