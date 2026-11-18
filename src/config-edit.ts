import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config, RepoConfig, ScheduleJob } from "./config";
import { parseCron } from "./scheduler";

/**
 * 页面可编辑的配置切片：仓库、worker 的并发与超时、定时任务。
 * 其余字段（通道、投递、GitHub 监听等）不动原文件里的内容，保存时原样保留。
 */
export interface EditableConfig {
  repos: RepoConfig[];
  worker: { adapter: string; command: string; concurrency: number; timeoutSec: number };
  schedules: ScheduleJob[];
}

export type ParseEditable = { ok: true; config: EditableConfig } | { ok: false; errors: string[] };

const ALIAS = /^[A-Za-z0-9_-]+$/;
const CONCURRENCY_MAX = 32;
const TIMEOUT_MAX_SEC = 24 * 60 * 60;

/** 页面拿到的是解析后的配置：path 已转绝对，照原样展示 */
export function editableConfig(cfg: Config): EditableConfig {
  return {
    repos: cfg.repos.map((r) => ({
      alias: r.alias,
      path: r.path,
      ...(r.remote ? { remote: r.remote } : {}),
      ...(r.baseBranch ? { baseBranch: r.baseBranch } : {}),
    })),
    worker: {
      adapter: cfg.worker.adapter,
      command: cfg.worker.command,
      concurrency: cfg.worker.concurrency,
      timeoutSec: cfg.worker.timeoutSec,
    },
    schedules: (cfg.schedules ?? []).map((s) => ({
      id: s.id,
      cron: s.cron,
      prompt: s.prompt,
      ...(s.repo ? { repo: s.repo } : {}),
      enabled: s.enabled !== false,
    })),
  };
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function int(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** 整份请求体当外部输入处理：逐项校验，错误带可定位的字段路径 */
export function parseEditable(input: unknown): ParseEditable {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["配置必须是 JSON 对象"] };
  }
  const raw = input as Record<string, unknown>;

  const repos: RepoConfig[] = [];
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    errors.push("repos 至少要有一个仓库");
  } else {
    const seen = new Set<string>();
    raw.repos.forEach((item, i) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        errors.push(`repos[${i}] 必须是对象`);
        return;
      }
      const r = item as Record<string, unknown>;
      const alias = text(r.alias);
      const path = text(r.path);
      if (!alias) errors.push(`repos[${i}].alias 不能为空`);
      else if (!ALIAS.test(alias)) errors.push(`repos[${i}].alias 只能用字母、数字、下划线和连字符`);
      else if (seen.has(alias)) errors.push(`repos[${i}].alias 重复：${alias}`);
      seen.add(alias);
      if (!path) errors.push(`repos[${i}].path 不能为空`);
      const remote = text(r.remote);
      const baseBranch = text(r.baseBranch);
      if (alias && path) {
        repos.push({ alias, path, ...(remote ? { remote } : {}), ...(baseBranch ? { baseBranch } : {}) });
      }
    });
  }

  const workerRaw = typeof raw.worker === "object" && raw.worker !== null ? (raw.worker as Record<string, unknown>) : {};
  const adapter = text(workerRaw.adapter);
  const command = text(workerRaw.command);
  const concurrency = int(workerRaw.concurrency, 1, CONCURRENCY_MAX);
  const timeoutSec = int(workerRaw.timeoutSec, 1, TIMEOUT_MAX_SEC);
  if (!adapter) errors.push("worker.adapter 不能为空");
  if (!command) errors.push("worker.command 不能为空");
  if (concurrency === null) errors.push(`worker.concurrency 必须是 1..${CONCURRENCY_MAX} 的整数`);
  if (timeoutSec === null) errors.push(`worker.timeoutSec 必须是 1..${TIMEOUT_MAX_SEC} 的整数`);

  const aliases = new Set(repos.map((r) => r.alias));
  const schedules: ScheduleJob[] = [];
  if (raw.schedules !== undefined && !Array.isArray(raw.schedules)) {
    errors.push("schedules 必须是数组");
  } else {
    const list = (raw.schedules ?? []) as unknown[];
    const seen = new Set<string>();
    list.forEach((item, i) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        errors.push(`schedules[${i}] 必须是对象`);
        return;
      }
      const s = item as Record<string, unknown>;
      const id = text(s.id);
      const cron = text(s.cron);
      const prompt = text(s.prompt);
      const repo = text(s.repo);
      if (!id) errors.push(`schedules[${i}].id 不能为空`);
      else if (seen.has(id)) errors.push(`schedules[${i}].id 重复：${id}`);
      seen.add(id);
      if (!cron) errors.push(`schedules[${i}].cron 不能为空`);
      else if (!parseCron(cron)) errors.push(`schedules[${i}].cron 不是合法的 5 段表达式：${cron}`);
      if (!prompt) errors.push(`schedules[${i}].prompt 不能为空`);
      if (repo && !aliases.has(repo)) errors.push(`schedules[${i}].repo 不在仓库列表里：${repo}`);
      if (s.enabled !== undefined && typeof s.enabled !== "boolean") errors.push(`schedules[${i}].enabled 必须是 true/false`);
      if (id && cron && prompt) {
        schedules.push({ id, cron, prompt, ...(repo ? { repo } : {}), enabled: s.enabled !== false });
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: { repos, worker: { adapter, command, concurrency: concurrency!, timeoutSec: timeoutSec! }, schedules },
  };
}

/**
 * 只覆盖 repos / worker 四项 / schedules，其余字段沿用原文件。
 * 先写临时文件再 rename，进程中途被杀也不会留下半份配置。
 */
export function saveEditableConfig(configPath: string, patch: EditableConfig): void {
  const abs = resolve(configPath);
  let raw: Record<string, unknown> = {};
  if (existsSync(abs)) {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${abs} 不是 JSON 对象`);
    }
    raw = parsed as Record<string, unknown>;
  }
  const worker = typeof raw.worker === "object" && raw.worker !== null ? (raw.worker as Record<string, unknown>) : {};
  const out = {
    ...raw,
    repos: patch.repos,
    worker: {
      ...worker,
      adapter: patch.worker.adapter,
      command: patch.worker.command,
      concurrency: patch.worker.concurrency,
      timeoutSec: patch.worker.timeoutSec,
    },
    schedules: patch.schedules,
  };
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
  renameSync(tmp, abs);
}

/** 审计用的单行摘要：不含 prompt 正文 */
export function summarizeEditable(c: EditableConfig): string {
  const repos = c.repos.map((r) => r.alias).join(",") || "(无)";
  return `repos=${repos} concurrency=${c.worker.concurrency} timeoutSec=${c.worker.timeoutSec} schedules=${c.schedules.length}`;
}
