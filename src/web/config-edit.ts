import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG, mergeConfig, type Config, type RepoConfig, type ScheduleJob } from "../config";
import { parseCron } from "../scheduler";

/** 控制台允许编辑的配置段；其余键原样保留 */
export interface ConfigPatch {
  repos?: unknown;
  worker?: unknown;
  /** 定时任务靠它拿 chatId/userId，缺了定时任务无法投递，所以一并可编辑 */
  scheduler?: unknown;
  schedules?: unknown;
}

export interface EditableConfig {
  repos: RepoConfig[];
  worker: Config["worker"];
  scheduler: NonNullable<Config["scheduler"]>;
  schedules: ScheduleJob[];
}

const PATCH_KEYS = ["repos", "worker", "scheduler", "schedules"] as const;
const OBJECT_KEYS = new Set(["worker", "scheduler"]);

const REPO_ALIAS = /^[A-Za-z0-9_-]+$/;
const JOB_ID = /^[A-Za-z0-9_-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function intInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** 页面上可编辑的三段；环境变量覆盖只在运行时生效，这里给文件与默认值的结果 */
export function configForEdit(cfg: Config): EditableConfig {
  return {
    repos: cfg.repos,
    worker: cfg.worker,
    scheduler: cfg.scheduler ?? { chatId: "", userId: "" },
    schedules: cfg.schedules ?? [],
  };
}

/** 读原始配置文件；文件不存在返回空对象，JSON 非法时抛出（调用方转成 4xx） */
export function readRawConfig(path: string): Record<string, unknown> {
  const abs = resolve(path);
  if (!existsSync(abs)) return {};
  const raw: unknown = JSON.parse(readFileSync(abs, "utf8"));
  if (!isRecord(raw)) throw new Error("配置文件顶层必须是 JSON 对象");
  return raw;
}

/** patch 只接受三段；非法键直接报错，避免把任意字段写进配置 */
export function patchKeys(patch: unknown): string[] {
  if (!isRecord(patch)) return ["请求体必须是对象"];
  const errors: string[] = [];
  const unknown = Object.keys(patch).filter((k) => !(PATCH_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) errors.push(`不支持的配置段：${unknown.join(", ")}`);
  for (const k of PATCH_KEYS) {
    if (patch[k] === undefined) continue;
    if (OBJECT_KEYS.has(k) && !isRecord(patch[k])) errors.push(`${k} 必须是对象`);
    if (!OBJECT_KEYS.has(k) && !Array.isArray(patch[k])) errors.push(`${k} 必须是数组`);
  }
  return errors;
}

/** 把 patch 合进原始配置；worker 是部分更新，其余两段整体替换 */
export function applyPatch(raw: Record<string, unknown>, patch: ConfigPatch): Record<string, unknown> {
  const next = { ...raw };
  if (patch.repos !== undefined) next.repos = patch.repos;
  if (patch.schedules !== undefined) next.schedules = patch.schedules;
  for (const key of OBJECT_KEYS) {
    const value = patch[key as keyof ConfigPatch];
    if (value === undefined) continue;
    const base = isRecord(raw[key]) ? (raw[key] as Record<string, unknown>) : {};
    next[key] = { ...base, ...(value as Record<string, unknown>) };
  }
  return next;
}

/**
 * 校验候选配置。合并默认值后再查，保证「只填一半」的配置也能得到确切结论。
 * 返回空数组表示可以落盘。
 */
export function validateConfig(raw: unknown): string[] {
  if (!isRecord(raw)) return ["配置必须是 JSON 对象"];
  if (raw.repos !== undefined && !Array.isArray(raw.repos)) return ["repos 必须是数组"];
  if (raw.schedules !== undefined && !Array.isArray(raw.schedules)) return ["schedules 必须是数组"];
  if (raw.worker !== undefined && !isRecord(raw.worker)) return ["worker 必须是对象"];
  if (raw.scheduler !== undefined && !isRecord(raw.scheduler)) return ["scheduler 必须是对象"];

  const cfg = mergeConfig(DEFAULT_CONFIG, raw as Partial<Config>);
  const errors: string[] = [];
  const aliases = new Set<string>();

  (cfg.repos as unknown[]).forEach((item, i) => {
    if (!isRecord(item)) {
      errors.push(`repos[${i}] 必须是对象`);
      return;
    }
    const alias = item.alias;
    if (!nonEmptyString(alias) || !REPO_ALIAS.test(alias)) {
      errors.push(`repos[${i}].alias 只能用字母、数字、下划线、连字符且非空`);
    } else if (aliases.has(alias)) {
      errors.push(`仓库别名重复：${alias}`);
    } else {
      aliases.add(alias);
    }
    if (!nonEmptyString(item.path)) errors.push(`repos[${i}].path 不能为空`);
    for (const key of ["remote", "baseBranch"] as const) {
      if (item[key] !== undefined && typeof item[key] !== "string") errors.push(`repos[${i}].${key} 必须是字符串`);
    }
  });

  const worker = cfg.worker as unknown as Record<string, unknown>;
  if (!nonEmptyString(worker.adapter)) errors.push("worker.adapter 不能为空");
  if (!nonEmptyString(worker.command)) errors.push("worker.command 不能为空");
  if (!intInRange(worker.timeoutSec, 1, 86_400)) errors.push("worker.timeoutSec 必须是 1–86400 的整数");
  if (!intInRange(worker.concurrency, 1, 64)) errors.push("worker.concurrency 必须是 1–64 的整数");
  if (!Array.isArray(worker.extraArgs) || !worker.extraArgs.every((a) => typeof a === "string")) {
    errors.push("worker.extraArgs 必须是字符串数组");
  }

  const jobs = (cfg.schedules ?? []) as unknown[];
  const jobIds = new Set<string>();
  jobs.forEach((item, i) => {
    if (!isRecord(item)) {
      errors.push(`schedules[${i}] 必须是对象`);
      return;
    }
    if (!nonEmptyString(item.id) || !JOB_ID.test(item.id)) {
      errors.push(`schedules[${i}].id 只能用字母、数字、下划线、连字符且非空`);
    } else if (jobIds.has(item.id)) {
      errors.push(`定时任务 id 重复：${item.id}`);
    } else {
      jobIds.add(item.id);
    }
    if (!nonEmptyString(item.cron) || !parseCron(item.cron)) errors.push(`schedules[${i}].cron 不是合法的 5 段 cron`);
    if (!nonEmptyString(item.prompt)) errors.push(`schedules[${i}].prompt 不能为空`);
    if (item.repo !== undefined) {
      if (!nonEmptyString(item.repo)) errors.push(`schedules[${i}].repo 必须是非空字符串`);
      else if (!aliases.has(item.repo)) errors.push(`schedules[${i}].repo 未在 repos 中定义：${item.repo}`);
    }
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") errors.push(`schedules[${i}].enabled 必须是布尔`);
  });

  const scheduler = cfg.scheduler;
  for (const key of ["chatId", "userId"] as const) {
    const v = scheduler?.[key];
    if (v !== undefined && typeof v !== "string") errors.push(`scheduler.${key} 必须是字符串`);
  }

  if (jobs.length > 0) {
    if (!nonEmptyString(cfg.scheduler?.chatId)) errors.push("配置了 schedules 时必须填写 scheduler.chatId");
    if (!nonEmptyString(cfg.scheduler?.userId)) errors.push("配置了 schedules 时必须填写 scheduler.userId");
  }

  return errors;
}

/** 临时文件 + rename：写一半不会留下坏配置 */
export function writeConfig(path: string, raw: Record<string, unknown>): void {
  const abs = resolve(path);
  const tmp = join(dirname(abs), `.${Date.now()}.${process.pid}.tmp.json`);
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  renameSync(tmp, abs);
}
