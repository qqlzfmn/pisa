import type { TaskStatus } from "../types";
import type { AuditEntry } from "../store";
import type { EditableConfig } from "./config-edit";
import type { DayPoint, QueuePoint } from "./metrics";

export interface TaskView {
  id: string;
  status: TaskStatus;
  repo: string;
  requester: string;
  prompt: string;
  durationMs: number;
  prUrl: string | null;
  canRewind: boolean;
}

/** 页面与 /api/state 共用的数据形状 */
export interface WebState {
  now: number;
  totals: Record<TaskStatus, number> & { total: number };
  tasks: TaskView[];
  daily: DayPoint[];
  queue: QueuePoint[];
  config: EditableConfig;
  configIssues: string[];
  audit: AuditEntry[];
}
