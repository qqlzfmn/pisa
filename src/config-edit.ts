import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG, type RepoConfig } from "./config";
import { parseCron } from "./scheduler";

/** Web 可编辑的仓库条目；字段与 RepoConfig 一致 */
export type EditableRepo = RepoConfig;

export interface EditableWorker {
  adapter: string;
  command: string;
  concurrency: number;
  timeoutSec: number;
  /** 只读展示：Web 不编辑这两个字段，避免误删凭据 */
  extraArgs: string[];
  envAllow: string[];
}

export interface EditableSchedule {
  id: string;
  cron: string;
  prompt: string;
  repo?: string;
  enabled: boolean;
}

export interface EditableConfig {
  path: string;
  repos: EditableRepo[];
  worker: EditableWorker;
  schedules: EditableSchedule[];
  /** schedules 需要 scheduler 身份才生效 */
  schedulerConfigured: boolean;
}

/** 提交给 POST /api/config 的补丁 */
export interface ConfigPatch {
  repos: EditableRepo[];
  worker: Pick<EditableWorker, "adapter" | "command" | "concurrency" | "timeoutSec">;
  schedules: EditableSchedule[];
}

export const CONCURRENCY_MAX = 64;
export const TIMEOUT_SEC_MAX = 86400;

export const NAME_RE = /^[A-Za-z0-9_-]+$/;

export type Validation = { ok: true; patch: ConfigPatch } | { ok: false; errors: string[] };

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

/** 读原始 JSON；缺失或损坏时当空配置，编辑界面从默认值起步 */
export function readRawConfig(path: string): Json {
  if (!existsSync(path)) return {};
  try {
    return asObject(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return {};
  }
}

function toEditableRepo(value: unknown): EditableRepo | null {
  const raw = asObject(value);
  const alias = asString(raw.alias);
  const p = asString(raw.path);
  if (!alias || !p) return null;
  const repo: EditableRepo = { alias, path: p };
  const remote = asString(raw.remote);
  if (remote) repo.remote = remote;
  const baseBranch = asString(raw.baseBranch);
  if (baseBranch) repo.baseBranch = baseBranch;
  return repo;
}

function toEditableSchedule(value: unknown): EditableSchedule | null {
  const raw = asObject(value);
  const id = asString(raw.id);
  const cron = asString(raw.cron);
  const prompt = asString(raw.prompt);
  if (!id || !cron || !prompt) return null;
  const job: EditableSchedule = { id, cron, prompt, enabled: raw.enabled !== false };
  const repo = asString(raw.repo);
  if (repo) job.repo = repo;
  return job;
}

/** 供编辑：读文件里的原始值，缺省字段回落 DEFAULT_CONFIG */
export function editableConfig(path: string): EditableConfig {
  const raw = readRawConfig(path);
  const workerRaw = asObject(raw.worker);
  const defaults = DEFAULT_CONFIG.worker;
  const envAllow = asStringArray(workerRaw.envAllow);

  const repos = Array.isArray(raw.repos)
    ? raw.repos.map(toEditableRepo).filter((repo): repo is EditableRepo => repo !== null)
    : [];
  const schedules = Array.isArray(raw.schedules)
    ? raw.schedules.map(toEditableSchedule).filter((job): job is EditableSchedule => job !== null)
    : [];
  const scheduler = asObject(raw.scheduler);

  return {
    path,
    repos,
    worker: {
      adapter: asString(workerRaw.adapter) ?? defaults.adapter,
      command: asString(workerRaw.command) ?? defaults.command,
      concurrency: asNumber(workerRaw.concurrency) ?? defaults.concurrency,
      timeoutSec: asNumber(workerRaw.timeoutSec) ?? defaults.timeoutSec,
      extraArgs: asStringArray(workerRaw.extraArgs) ?? [...defaults.extraArgs],
      envAllow: envAllow ?? [...(defaults.envAllow ?? [])],
    },
    schedules,
    schedulerConfigured: Boolean(asString(scheduler.chatId) && asString(scheduler.userId)),
  };
}

function validateRepos(input: unknown, errors: string[]): EditableRepo[] {
  if (!Array.isArray(input)) {
    errors.push("repos 必须是数组");
    return [];
  }
  const out: EditableRepo[] = [];
  const seen = new Set<string>();
  input.forEach((item, index) => {
    const raw = asObject(item);
    const alias = (asString(raw.alias) ?? "").trim();
    const path = (asString(raw.path) ?? "").trim();
    const label = `repos[${index}]`;
    if (!alias) errors.push(`${label}.alias 不能为空`);
    else if (!NAME_RE.test(alias)) errors.push(`${label}.alias 只能用字母、数字、下划线和短横线：${alias}`);
    else if (seen.has(alias)) errors.push(`${label}.alias 重复：${alias}`);
    if (!path) errors.push(`${label}.path 不能为空`);
    if (!alias || seen.has(alias)) return;
    seen.add(alias);
    const repo: EditableRepo = { alias, path };
    const remote = (asString(raw.remote) ?? "").trim();
    if (remote) repo.remote = remote;
    const baseBranch = (asString(raw.baseBranch) ?? "").trim();
    if (baseBranch) repo.baseBranch = baseBranch;
    out.push(repo);
  });
  return out;
}

function validateWorker(input: unknown, errors: string[]): ConfigPatch["worker"] {
  const raw = asObject(input);
  const adapter = (asString(raw.adapter) ?? "").trim();
  const command = (asString(raw.command) ?? "").trim();
  if (!adapter) errors.push("worker.adapter 不能为空");
  if (!command) errors.push("worker.command 不能为空");
  const concurrency = asNumber(raw.concurrency);
  if (concurrency === undefined || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > CONCURRENCY_MAX) {
    errors.push(`worker.concurrency 必须是 1..${CONCURRENCY_MAX} 的整数`);
  }
  const timeoutSec = asNumber(raw.timeoutSec);
  if (timeoutSec === undefined || !Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > TIMEOUT_SEC_MAX) {
    errors.push(`worker.timeoutSec 必须是 1..${TIMEOUT_SEC_MAX} 的整数`);
  }
  return {
    adapter,
    command,
    concurrency: concurrency ?? DEFAULT_CONFIG.worker.concurrency,
    timeoutSec: timeoutSec ?? DEFAULT_CONFIG.worker.timeoutSec,
  };
}

function validateSchedules(
  input: unknown,
  repoNames: ReadonlySet<string>,
  errors: string[],
): EditableSchedule[] {
  if (!Array.isArray(input)) {
    errors.push("schedules 必须是数组");
    return [];
  }
  const out: EditableSchedule[] = [];
  const seen = new Set<string>();
  input.forEach((item, index) => {
    const raw = asObject(item);
    const id = (asString(raw.id) ?? "").trim();
    const cron = (asString(raw.cron) ?? "").trim();
    const prompt = (asString(raw.prompt) ?? "").trim();
    const label = `schedules[${index}]`;
    if (!id) errors.push(`${label}.id 不能为空`);
    else if (!NAME_RE.test(id)) errors.push(`${label}.id 只能用字母、数字、下划线和短横线：${id}`);
    else if (seen.has(id)) errors.push(`${label}.id 重复：${id}`);
    if (seen.has(id)) return;
    if (!cron) errors.push(`${label}.cron 不能为空`);
    else if (!parseCron(cron)) errors.push(`${label}.cron 无法解析：${cron}`);
    if (!prompt) errors.push(`${label}.prompt 不能为空`);
    const repo = (asString(raw.repo) ?? "").trim();
    if (repo && !repoNames.has(repo)) errors.push(`${label}.repo 不在仓库列表里：${repo}`);
    seen.add(id);
    const job: EditableSchedule = { id, cron, prompt, enabled: raw.enabled !== false };
    if (repo) job.repo = repo;
    out.push(job);
  });
  return out;
}

/** 校验整份可编辑配置；错误面向使用者，逐条可读 */
export function validateConfigPatch(input: unknown): Validation {
  const errors: string[] = [];
  const patchRaw = asObject(input);
  const repos = validateRepos(patchRaw.repos, errors);
  const worker = validateWorker(patchRaw.worker, errors);
  const aliases = new Set(repos.map((repo) => repo.alias));
  const schedules = validateSchedules(patchRaw.schedules, aliases, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, patch: { repos, worker, schedules } };
}

/** 把补丁合并进原文件并原子写入；只覆盖 Web 负责的键 */
export function saveConfigPatch(path: string, patch: ConfigPatch): void {
  const raw = readRawConfig(path);
  // Web 只编辑 alias/path/remote/baseBranch；capabilities 等文件里的键按 alias 保留
  const existing = new Map<string, Json>();
  if (Array.isArray(raw.repos)) {
    for (const item of raw.repos) {
      const repo = asObject(item);
      const alias = asString(repo.alias);
      if (alias) existing.set(alias, repo);
    }
  }
  raw.repos = patch.repos.map((repo) => ({ ...existing.get(repo.alias), ...repo }));
  raw.worker = {
    ...asObject(raw.worker),
    adapter: patch.worker.adapter,
    command: patch.worker.command,
    concurrency: patch.worker.concurrency,
    timeoutSec: patch.worker.timeoutSec,
  };
  raw.schedules = patch.schedules;

  const whitelist = asObject(raw.whitelist);
  const whitelistRepos = asStringArray(whitelist.repos);
  if (whitelistRepos && whitelistRepos.length > 0) {
    raw.whitelist = { ...whitelist, repos: patch.repos.map((repo) => repo.alias) };
  }

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
  renameSync(tmp, path);
}
