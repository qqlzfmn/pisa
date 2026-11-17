import { resolve } from "node:path";
import type { Config } from "../config";
import { DEFAULT_CONFIG, mergeConfig, repoByAlias } from "../config";
import type { Store } from "../store";
import type { Task, TaskStatus } from "../types";
import { applyRewind, formatRewindPlan, formatRewindResult, planRewind, type RewindPlan, type RewindProbes } from "../rewind";
import { rewindProbes } from "../rewind-probes";
import { defaultRunner, type Runner } from "../github";
import { Confirmations } from "./confirm";
import type { ConfigPatch, EditableConfig } from "./config-edit";
import { applyPatch, configForEdit, patchKeys, readRawConfig, validateConfig, writeConfig } from "./config-edit";
import { dailyMetrics, queueDepth } from "./metrics";
import { renderPage } from "./page";
import type { TaskView, WebState } from "./view";

export interface WebDeps {
  cfg: Config;
  store: Store;
  /** pisa.config.json 的路径；与启动时 loadConfig 用的是同一个 */
  configPath: string;
  runner?: Runner;
  probes?: RewindProbes;
  now?: () => number;
  confirmations?: Confirmations;
}

const REWINDABLE: TaskStatus[] = ["succeeded", "failed", "cancelled"];
const TASK_LIMIT = 50;
const AUDIT_LIMIT = 30;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const fail = (error: string, status = 400): Response => json({ ok: false, error }, status);

function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 只保留白名单里的键，保证预览与保存对同一 patch 得到同一令牌载荷 */
function normalizePatch(patch: ConfigPatch): ConfigPatch {
  const out: ConfigPatch = {};
  if (patch.repos !== undefined) out.repos = patch.repos;
  if (patch.worker !== undefined) out.worker = patch.worker;
  if (patch.scheduler !== undefined) out.scheduler = patch.scheduler;
  if (patch.schedules !== undefined) out.schedules = patch.schedules;
  return out;
}

export function createWebApp(deps: WebDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const confirmations = deps.confirmations ?? new Confirmations();
  const probes = deps.probes ?? rewindProbes(deps.runner);

  /** 页面展示的是文件里的值（合并默认值），不是环境变量覆盖后的运行时值 */
  function readConfig(): { config: EditableConfig; issues: string[] } {
    let raw: Record<string, unknown> = {};
    let issues: string[] = [];
    try {
      raw = readRawConfig(deps.configPath);
      issues = validateConfig(raw);
    } catch (err) {
      issues = [`读取配置失败：${(err as Error).message}`];
    }
    if (issues.length > 0) return { config: configForEdit(deps.cfg), issues };
    return { config: configForEdit(mergeConfig(DEFAULT_CONFIG, raw as Partial<Config>)), issues: [] };
  }

  function taskViews(recent: Task[]): TaskView[] {
    const at = now();
    return recent.map((t) => ({
      id: t.id,
      status: t.status,
      repo: t.repo,
      requester: t.requester,
      prompt: preview(t.prompt, 60),
      durationMs: Math.max(0, (t.endedAt ?? at) - (t.startedAt ?? t.createdAt)),
      prUrl: t.prUrl,
      canRewind: REWINDABLE.includes(t.status),
    }));
  }

  function state(): WebState {
    const at = now();
    const counts = deps.store.countByStatus();
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const recent = deps.store.tasksTouchedSince(at - 8 * 86_400_000);
    const { config, issues } = readConfig();
    return {
      now: at,
      totals: { ...counts, total },
      tasks: taskViews(deps.store.recentTasks(TASK_LIMIT)),
      daily: dailyMetrics(recent, at),
      queue: queueDepth(recent, at),
      config,
      configIssues: issues,
      audit: deps.store.auditLog(AUDIT_LIMIT),
    };
  }

  /** rewind 前置条件；返回错误响应或可执行目标 */
  function rewindTarget(id: string): { task: Task; repoPath: string; base: string } | Response {
    if (!id) return fail("缺少 taskId");
    const task = deps.store.get(id);
    if (!task) return fail(`找不到任务 ${id}`, 404);
    if (task.status === "rewound") return fail(`任务 ${id} 已撤销`, 409);
    if (!REWINDABLE.includes(task.status)) return fail(`任务 ${id} 状态为 ${task.status}，先等它结束`, 409);
    const repo = repoByAlias(deps.cfg, task.repo);
    if (!repo) return fail(`仓库未配置：${task.repo}`, 409);
    return { task, repoPath: repo.path, base: repo.baseBranch ?? "main" };
  }

  function plan(id: string): RewindPlan {
    const target = rewindTarget(id);
    if (target instanceof Response) throw target;
    return planRewind(target.task, deps.store.effectsOf(id), {
      repoPath: target.repoPath,
      baseBranch: target.base,
      probes,
    });
  }

  function rewindPreview(id: string): Response {
    let p: RewindPlan;
    try {
      p = plan(id);
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }
    return json({
      ok: true,
      taskId: id,
      merge: p.merge,
      actions: p.actions.map((a) => a.label),
      irreversible: p.irreversible,
      notes: p.notes,
      text: formatRewindPlan(p, deps.cfg.trigger),
      token: confirmations.issue("rewind.apply", id, { taskId: id }),
    });
  }

  function rewindApply(id: string, token: string): Response {
    let p: RewindPlan;
    try {
      p = plan(id);
    } catch (err) {
      if (err instanceof Response) return err;
      throw err;
    }
    const actor = "web";
    if (!confirmations.consume("rewind.apply", id, token, { taskId: id })) {
      deps.store.audit({ actor, action: "rewind", target: id, detail: "确认令牌无效或已过期", ok: false });
      return fail("确认令牌无效或已过期，请重新预览", 409);
    }

    if (p.actions.length === 0) {
      const marked = p.merge !== "unknown";
      if (marked) deps.store.transition(id, "rewound");
      deps.store.audit({
        actor,
        action: "rewind",
        target: id,
        detail: marked ? "无动作，已标记撤销" : "无动作，PR 状态未知未标记",
        ok: marked,
      });
      return json({ ok: true, text: formatRewindResult(p, []), detail: "没有需要执行的撤销动作。" });
    }

    const results = applyRewind(p, {
      taskId: id,
      runner: deps.runner ?? defaultRunner,
      commitName: deps.cfg.delivery.commitName,
      commitEmail: deps.cfg.delivery.commitEmail,
    });
    for (const r of results) {
      if (r.ok && r.effect) deps.store.removeEffect(id, r.effect.kind, r.effect.target);
    }
    const allOk = results.every((r) => r.ok);
    const rewound = p.merge !== "unknown" && allOk;
    if (rewound) deps.store.transition(id, "rewound");
    const text = formatRewindResult(p, results);
    deps.store.audit({ actor, action: "rewind", target: id, detail: text.slice(0, 2000), ok: allOk });
    return json({ ok: allOk, text });
  }

  async function saveConfig(body: { patch?: ConfigPatch; dryRun?: boolean; token?: string }): Promise<Response> {
    const patch = normalizePatch(body.patch ?? {});
    const shapeErrors = patchKeys(body.patch ?? {});
    if (shapeErrors.length > 0) return json({ ok: false, errors: shapeErrors }, 400);

    let raw: Record<string, unknown>;
    try {
      raw = readRawConfig(deps.configPath);
    } catch (err) {
      return fail(`读取配置失败：${(err as Error).message}`, 409);
    }
    const candidate = applyPatch(raw, patch);
    const errors = validateConfig(candidate);
    const target = "config";

    if (errors.length > 0) {
      if (!body.dryRun) {
        deps.store.audit({ actor: "web", action: "config.save", target, detail: errors.join("; ").slice(0, 2000), ok: false });
      }
      return json({ ok: false, errors }, 422);
    }

    const changed = Object.keys(patch);
    if (body.dryRun) {
      return json({ ok: true, token: confirmations.issue("config.save", target, patch), changed, requiresRestart: true });
    }
    if (!body.token) return fail("需要先预览并确认", 428);
    if (!confirmations.consume("config.save", target, body.token, patch)) {
      deps.store.audit({ actor: "web", action: "config.save", target, detail: "确认令牌无效或已过期", ok: false });
      return fail("确认令牌无效或已过期，请重新校验", 409);
    }
    try {
      writeConfig(deps.configPath, candidate);
    } catch (err) {
      const msg = `写入配置失败：${(err as Error).message}`;
      deps.store.audit({ actor: "web", action: "config.save", target, detail: msg, ok: false });
      return fail(msg, 500);
    }
    deps.store.audit({
      actor: "web",
      action: "config.save",
      target,
      detail: JSON.stringify({ changed, path: resolve(deps.configPath) }).slice(0, 2000),
      ok: true,
    });
    return json({ ok: true, saved: true, changed, requiresRestart: true, path: resolve(deps.configPath) });
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(renderPage(state()), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/state" && req.method === "GET") return json({ ok: true, state: state() });

    if (req.method !== "POST") return fail("method not allowed", 405);

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return fail("请求体必须是 JSON", 400);
    }

    if (url.pathname === "/api/rewind/preview") return rewindPreview(String(body.taskId ?? ""));
    if (url.pathname === "/api/rewind/apply") {
      return rewindApply(String(body.taskId ?? ""), String(body.token ?? ""));
    }
    if (url.pathname === "/api/config") {
      return saveConfig(body as { patch?: ConfigPatch; dryRun?: boolean; token?: string });
    }
    return fail("not found", 404);
  }

  return async (req) => {
    try {
      return await route(req);
    } catch (err) {
      if (err instanceof Response) return err;
      const msg = (err as Error).message ?? String(err);
      console.error(`[pisa] web 请求失败：${msg.slice(0, 300)}`);
      return fail(msg.slice(0, 300), 500);
    }
  };
}

export function startWebConsole(deps: WebDeps): void {
  const server = Bun.serve({
    port: deps.cfg.web?.port ?? DEFAULT_CONFIG.web!.port,
    hostname: "127.0.0.1",
    fetch: createWebApp(deps),
  });
  console.log(`[pisa] web 控制台：http://127.0.0.1:${server.port}`);
}
