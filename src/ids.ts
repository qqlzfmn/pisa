import { randomBytes } from "node:crypto";

/** 任务号：t_<yyyyMMdd>_<6 位十六进制>，同日可排序、不依赖数据库自增 */
export function newTaskId(now = Date.now()): string {
  const d = new Date(now);
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `t_${ymd}_${randomBytes(3).toString("hex")}`;
}
