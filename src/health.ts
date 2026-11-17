import type { Store } from "./store";
import { METRICS_WINDOW_MS, summarize } from "./metrics";

export interface RepoLoad {
  repo: string;
  running: number;
  queued: number;
  /** 最近 24 小时完成的该仓库任务数 */
  finished24h: number;
}

export interface HealthReport {
  ok: boolean;
  uptimeSec: number;
  running: number;
  queueDepth: number;
  repos: RepoLoad[];
  last24h: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    successRate: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  error?: string;
}

/** 只读快照；存储读取失败时抛出，由服务层转成 503 */
export function healthReport(store: Store, startedAt: number, now: number): HealthReport {
  const since = now - METRICS_WINDOW_MS;
  const metrics = summarize(store.finishedSince(since), since);

  const byRepo = new Map<string, RepoLoad>();
  const load = (repo: string): RepoLoad => {
    let entry = byRepo.get(repo);
    if (!entry) {
      entry = { repo, running: 0, queued: 0, finished24h: metrics.byRepo[repo] ?? 0 };
      byRepo.set(repo, entry);
    }
    return entry;
  };
  let running = 0;
  let queueDepth = 0;
  for (const row of store.activeByRepo()) {
    const entry = load(row.repo);
    if (row.status === "running") {
      entry.running = row.n;
      running += row.n;
    } else if (row.status === "queued") {
      entry.queued = row.n;
      queueDepth += row.n;
    }
  }
  for (const repo of Object.keys(metrics.byRepo)) load(repo);

  const repos = [...byRepo.values()]
    .filter((r) => r.running + r.queued + r.finished24h > 0)
    .sort((a, b) => a.repo.localeCompare(b.repo));

  return {
    ok: true,
    uptimeSec: Math.max(0, Math.floor((now - startedAt) / 1000)),
    running,
    queueDepth,
    repos,
    last24h: {
      total: metrics.total,
      succeeded: metrics.succeeded,
      failed: metrics.failed,
      cancelled: metrics.cancelled,
      successRate: metrics.successRate,
      p50Ms: metrics.p50Ms,
      p95Ms: metrics.p95Ms,
    },
  };
}

export interface HealthServerDeps {
  store: Store;
  port: number;
  /** 进程启动时刻，用于 uptime */
  startedAt: number;
  now?: () => number;
}

export type HealthServer = Bun.Server<undefined>;

/** 只监听回环地址的只读探活接口；端口占用由调用方决定如何处理 */
export function startHealthServer(deps: HealthServerDeps): HealthServer {
  const now = deps.now ?? Date.now;
  return Bun.serve({
    port: deps.port,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname !== "/health") return new Response("not found", { status: 404 });
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json(healthReport(deps.store, deps.startedAt, now()));
      } catch (err) {
        return Response.json(
          {
            ok: false,
            uptimeSec: Math.max(0, Math.floor((now() - deps.startedAt) / 1000)),
            error: err instanceof Error ? err.message : String(err),
          },
          { status: 503 },
        );
      }
    },
  });
}
