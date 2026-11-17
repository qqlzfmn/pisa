/**
 * 不可信代码（Worker 写的测试）只能拿到跑测试必需的最小环境。
 * 白名单而非黑名单：黑名单永远漏；凭据与 pisa 自己的配置一律不传。
 */
const PASSTHROUGH = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM"] as const;

/** 受限执行环境；extra 用于显式追加确需的变量 */
export function workerEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}
