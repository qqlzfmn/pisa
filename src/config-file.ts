import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_IDLE_TIMEOUT_SEC, loadConfig, type Config, type RepoConfig, type ScheduleJob } from "./config";
import { parseCron } from "./scheduler";

/**
 * 页面可编辑的配置子集：仓库、Worker 的执行参数、定时任务。
 * 白名单、通道、webhook 等敏感段仍手改文件，避免一个 token 就能改认证面。
 */
export interface ConfigDraft {
  repos: RepoConfig[];
  worker: {
    adapter: string;
    command: string;
    concurrency: number;
    timeoutSec: number;
    idleTimeoutSec: number;
  };
  schedules: ScheduleJob[];
}

export type DraftValidation = { ok: true; draft: ConfigDraft } | { ok: false; errors: string[] };

const ALIAS = /^[A-Za-z0-9_-]+$/;
const CONCURRENCY_RANGE = [1, 32] as const;
const TIMEOUT_RANGE = [1, 86_400] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 可编辑字段的规范化投影：默认值补齐、可选字段按有无输出，两侧比较时不因键序或省略产生假差异 */
export function configDraft(cfg: Config): ConfigDraft {
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
      idleTimeoutSec: cfg.worker.idleTimeoutSec ?? DEFAULT_IDLE_TIMEOUT_SEC,
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

/** 配置文件「重启后会生效」的值：与真实启动走同一个 loadConfig，路径解析与默认值不另立口径 */
export function draftFromFile(path: string, fallback: ConfigDraft): { draft: ConfigDraft; error: string | null } {
  try {
    return { draft: configDraft(loadConfig(path)), error: null };
  } catch (e) {
    return { draft: fallback, error: `配置文件无法解析：${String(e).slice(0, 200)}` };
  }
}

export function sameDraft(a: ConfigDraft, b: ConfigDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 表单输入的数字：接受数字字符串，要求整数且落在区间内 */
function intIn(value: unknown, [min, max]: readonly [number, number]): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** 校验并规范化页面提交的草稿；错误一次列全，调用方据此回 400 且不碰文件 */
export function validateDraft(input: unknown): DraftValidation {
  if (!isObject(input)) return { ok: false, errors: ["请求体缺少 draft"] };
  const errors: string[] = [];
  const aliases = new Set<string>();

  const repos: RepoConfig[] = [];
  if (!Array.isArray(input.repos) || input.repos.length === 0) {
    errors.push("至少配置一个仓库");
  } else {
    input.repos.forEach((raw, i) => {
      const at = `repos 第 ${i + 1} 项`;
      if (!isObject(raw)) {
        errors.push(`${at} 不是对象`);
        return;
      }
      const alias = typeof raw.alias === "string" ? raw.alias.trim() : "";
      const path = typeof raw.path === "string" ? raw.path.trim() : "";
      if (!ALIAS.test(alias)) errors.push(`${at} 的别名只能使用字母、数字、下划线与短横线：${alias || "(空)"}`);
      else if (aliases.has(alias)) errors.push(`仓库别名重复：${alias}`);
      else aliases.add(alias);
      if (!path) errors.push(`仓库 ${alias || at} 的路径为空`);
      for (const field of ["remote", "baseBranch"] as const) {
        if (raw[field] !== undefined && raw[field] !== null && typeof raw[field] !== "string") {
          errors.push(`仓库 ${alias || at} 的 ${field} 必须是字符串`);
        }
      }
      const remote = typeof raw.remote === "string" ? raw.remote.trim() : "";
      const baseBranch = typeof raw.baseBranch === "string" ? raw.baseBranch.trim() : "";
      repos.push({ alias, path, ...(remote ? { remote } : {}), ...(baseBranch ? { baseBranch } : {}) });
    });
  }

  const worker: ConfigDraft["worker"] = { adapter: "", command: "", concurrency: 0, timeoutSec: 0, idleTimeoutSec: 0 };
  if (!isObject(input.worker)) {
    errors.push("worker 必须是对象");
  } else {
    const w = input.worker;
    worker.adapter = typeof w.adapter === "string" ? w.adapter.trim() : "";
    worker.command = typeof w.command === "string" ? w.command.trim() : "";
    if (!worker.adapter) errors.push("worker.adapter 不能为空");
    if (!worker.command) errors.push("worker.command 不能为空");
    const concurrency = intIn(w.concurrency, CONCURRENCY_RANGE);
    worker.concurrency = concurrency ?? 0;
    if (concurrency === null) errors.push(`worker.concurrency 必须是 ${CONCURRENCY_RANGE[0]}–${CONCURRENCY_RANGE[1]} 的整数`);
    for (const field of ["timeoutSec", "idleTimeoutSec"] as const) {
      const n = intIn(w[field], TIMEOUT_RANGE);
      worker[field] = n ?? 0;
      if (n === null) errors.push(`worker.${field} 必须是 ${TIMEOUT_RANGE[0]}–${TIMEOUT_RANGE[1]} 的整数`);
    }
  }

  const schedules: ScheduleJob[] = [];
  if (!Array.isArray(input.schedules)) {
    errors.push("schedules 必须是数组");
  } else {
    const ids = new Set<string>();
    input.schedules.forEach((raw, i) => {
      const at = `schedules 第 ${i + 1} 项`;
      if (!isObject(raw)) {
        errors.push(`${at} 不是对象`);
        return;
      }
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      const cron = typeof raw.cron === "string" ? raw.cron.trim() : "";
      const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
      const repo = typeof raw.repo === "string" ? raw.repo.trim() : "";
      if (!ALIAS.test(id)) errors.push(`${at} 的 id 只能使用字母、数字、下划线与短横线：${id || "(空)"}`);
      else if (ids.has(id)) errors.push(`定时任务 id 重复：${id}`);
      else ids.add(id);
      if (!cron || !parseCron(cron)) errors.push(`定时任务 ${id || at} 的 cron 无法解析：${cron || "(空)"}`);
      if (!prompt) errors.push(`定时任务 ${id || at} 的 prompt 为空`);
      if (repo && !aliases.has(repo)) errors.push(`定时任务 ${id || at} 指向未配置的仓库：${repo}`);
      if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") errors.push(`定时任务 ${id || at} 的 enabled 必须是布尔值`);
      schedules.push({ id, cron, prompt, ...(repo ? { repo } : {}), enabled: raw.enabled !== false });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, draft: { repos, worker, schedules } };
}

/**
 * 只回写受管字段：其它键原样保留，worker 浅合并以保住 extraArgs / envAllow。
 * 临时文件 + rename，避免进程中断留下半截 JSON。文件已损坏时抛错，不覆盖用户内容。
 */
export function writeConfigPatch(path: string, draft: ConfigDraft): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(parsed)) throw new Error("配置文件的根必须是 JSON 对象");
    raw = parsed;
  }
  raw.repos = draft.repos;
  raw.worker = { ...(isObject(raw.worker) ? raw.worker : {}), ...draft.worker };
  raw.schedules = draft.schedules;

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  renameSync(tmp, path);
}
