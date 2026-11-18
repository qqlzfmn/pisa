import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Config, ScheduleJob } from "./config";
import { parseCron } from "./scheduler";

/**
 * Web 控制台编辑配置的中间结构。
 * `allowed` 不是配置文件字段，它对应 whitelist.repos，保存时由这一列重写白名单。
 */
export interface EditableRepo {
  alias: string;
  path: string;
  baseBranch: string;
  remote: string;
  allowed: boolean;
}

export interface EditableWorker {
  adapter: string;
  command: string;
  timeoutSec: number;
  concurrency: number;
  extraArgs: string[];
}

export interface EditableConfig {
  repos: EditableRepo[];
  worker: EditableWorker;
  schedules: ScheduleJob[];
}

export type ValidateResult = { ok: true; value: EditableConfig } | { ok: false; errors: string[] };

export const REPO_ALIAS_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CONCURRENCY = 32;
const MAX_TIMEOUT_SEC = 86_400;

export function editableConfig(cfg: Config): EditableConfig {
  const allowed = new Set(cfg.whitelist.repos);
  return {
    repos: cfg.repos.map((repo) => ({
      alias: repo.alias,
      path: repo.path,
      baseBranch: repo.baseBranch ?? "",
      remote: repo.remote ?? "",
      allowed: allowed.has(repo.alias),
    })),
    worker: {
      adapter: cfg.worker.adapter,
      command: cfg.worker.command,
      timeoutSec: cfg.worker.timeoutSec,
      concurrency: cfg.worker.concurrency,
      extraArgs: [...cfg.worker.extraArgs],
    },
    schedules: (cfg.schedules ?? []).map((job) => ({ ...job })),
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 保存前的完整校验。`baseDir` 是配置文件所在目录，相对 repos.path 按它解析。
 * 返回的全部错误一起给页面，避免用户逐条试错。
 */
export function validateEditable(raw: unknown, baseDir: string, adapters: readonly string[]): ValidateResult {
  const errors: string[] = [];
  const root = recordOf(raw);
  if (!root) return { ok: false, errors: ["配置必须是 JSON 对象"] };

  const repos: EditableRepo[] = [];
  const aliases = new Set<string>();
  if (!Array.isArray(root.repos)) {
    errors.push("repos 必须是数组");
  } else {
    root.repos.forEach((item, index) => {
      const repo = recordOf(item);
      if (!repo) {
        errors.push(`repos[${index}] 必须是对象`);
        return;
      }
      const alias = optionalString(repo.alias);
      const path = optionalString(repo.path);
      if (!alias) errors.push(`repos[${index}].alias 不能为空`);
      else if (!REPO_ALIAS_PATTERN.test(alias)) errors.push(`repos[${index}].alias 只能包含字母、数字、下划线与连字符：${alias}`);
      else if (aliases.has(alias)) errors.push(`仓库别名重复：${alias}`);
      if (alias && REPO_ALIAS_PATTERN.test(alias)) aliases.add(alias);
      if (!path) errors.push(`repos[${index}].path 不能为空`);
      else {
        const abs = isAbsolute(path) ? path : resolve(baseDir, path);
        let directory = false;
        try {
          directory = existsSync(abs) && statSync(abs).isDirectory();
        } catch {
          directory = false;
        }
        if (!directory) errors.push(`repos[${index}].path 不是已存在的目录：${path}`);
      }
      if (repo.allowed !== undefined && typeof repo.allowed !== "boolean") errors.push(`repos[${index}].allowed 必须是布尔值`);
      const baseBranch = optionalString(repo.baseBranch);
      const remote = optionalString(repo.remote);
      repos.push({ alias, path, baseBranch, remote, allowed: repo.allowed === true });
    });
  }

  const workerRaw = recordOf(root.worker);
  if (!workerRaw) errors.push("worker 必须是对象");
  const worker = workerRaw ?? {};
  const adapter = optionalString(worker.adapter);
  if (!adapter) errors.push("worker.adapter 不能为空");
  else if (!adapters.includes(adapter)) errors.push(`worker.adapter 未知：${adapter}（可用：${adapters.join(", ")}）`);
  const command = optionalString(worker.command);
  if (!command) errors.push("worker.command 不能为空");

  const integerField = (value: unknown, label: string, min: number, max: number): number => {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push(`${label} 必须是整数`);
      return value as number;
    }
    if (value < min || value > max) {
      errors.push(`${label} 必须在 ${min}–${max} 之间`);
      return value;
    }
    return value;
  };
  const timeoutSec = integerField(worker.timeoutSec, "worker.timeoutSec", 1, MAX_TIMEOUT_SEC);
  const concurrency = integerField(worker.concurrency, "worker.concurrency", 1, MAX_CONCURRENCY);

  let extraArgs: string[] = [];
  if (!Array.isArray(worker.extraArgs)) errors.push("worker.extraArgs 必须是字符串数组");
  else if (worker.extraArgs.some((arg) => typeof arg !== "string")) errors.push("worker.extraArgs 必须是字符串数组");
  else extraArgs = worker.extraArgs;

  const schedules: ScheduleJob[] = [];
  if (root.schedules !== undefined && !Array.isArray(root.schedules)) {
    errors.push("schedules 必须是数组");
  } else if (Array.isArray(root.schedules)) {
    const ids = new Set<string>();
    root.schedules.forEach((item, index) => {
      const rawJob = recordOf(item);
      if (!rawJob) {
        errors.push(`schedules[${index}] 必须是对象`);
        return;
      }
      const id = optionalString(rawJob.id);
      const cron = optionalString(rawJob.cron);
      const prompt = optionalString(rawJob.prompt);
      const repo = optionalString(rawJob.repo);
      if (!id) errors.push(`schedules[${index}].id 不能为空`);
      else if (!REPO_ALIAS_PATTERN.test(id)) errors.push(`schedules[${index}].id 只能包含字母、数字、下划线与连字符：${id}`);
      else if (ids.has(id)) errors.push(`定时任务 id 重复：${id}`);
      if (id && REPO_ALIAS_PATTERN.test(id)) ids.add(id);
      if (!cron) errors.push(`schedules[${index}].cron 不能为空`);
      else if (!parseCron(cron)) errors.push(`schedules[${index}].cron 不是合法的 5 段 cron：${cron}`);
      if (!prompt) errors.push(`schedules[${index}].prompt 不能为空`);
      if (repo && !aliases.has(repo)) errors.push(`schedules[${index}].repo 未在 repos 中定义：${repo}`);
      const enabled = rawJob.enabled;
      if (enabled !== undefined && typeof enabled !== "boolean") errors.push(`schedules[${index}].enabled 必须是布尔值`);
      const job: ScheduleJob = { id, cron, prompt };
      if (repo) job.repo = repo;
      if (enabled === false) job.enabled = false;
      schedules.push(job);
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      repos,
      worker: { adapter, command, timeoutSec, concurrency, extraArgs },
      schedules,
    },
  };
}

/**
 * 把编辑结果写回配置文件：保留未编辑的键（delivery、notifications 等），
 * 只换掉 repos / whitelist.repos / worker 三个编辑区与 schedules。先写临时文件再 rename，避免半截文件。
 */
export function saveEditableConfig(path: string, value: EditableConfig): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const existing = recordOf(parsed);
    if (!existing) throw new Error("现有配置文件不是 JSON 对象，拒绝覆盖");
    raw = existing;
  }

  const prevWhitelist = recordOf(raw.whitelist) ?? {};
  const prevWorker = recordOf(raw.worker) ?? {};
  const next: Record<string, unknown> = {
    ...raw,
    repos: value.repos.map(({ allowed: _allowed, ...repo }) => {
      const out: Record<string, unknown> = { alias: repo.alias, path: repo.path };
      if (repo.baseBranch) out.baseBranch = repo.baseBranch;
      if (repo.remote) out.remote = repo.remote;
      return out;
    }),
    whitelist: { ...prevWhitelist, repos: value.repos.filter((repo) => repo.allowed).map((repo) => repo.alias) },
    worker: {
      ...prevWorker,
      adapter: value.worker.adapter,
      command: value.worker.command,
      timeoutSec: value.worker.timeoutSec,
      concurrency: value.worker.concurrency,
      extraArgs: value.worker.extraArgs,
    },
    schedules: value.schedules.map((job) => ({ ...job })),
  };

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
}
