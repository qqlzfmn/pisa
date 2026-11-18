import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../src/api";
import type { Config } from "../src/config";
import { GitDeliverer } from "../src/deliver";
import { sh } from "../src/git";
import { writeApiInfo } from "../src/management";
import { Router } from "../src/router";
import { Store } from "../src/store";
import type { ChannelAdapter, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";

class NullChannel implements ChannelAdapter {
  name = "null";
  async start(): Promise<void> {}
  async send(): Promise<{ messageId: string }> {
    return { messageId: "0" };
  }
  async stop(): Promise<void> {}
}

/** 管理接口测试台：真实 HTTP 服务 + 真实 Store，Worker 永不执行 */
export interface Harness {
  root: string;
  repo: string;
  stateDir: string;
  cfgPath: string;
  cfg: Config;
  store: Store;
  router: Router;
  port: number;
  token: string;
  stop(): void;
}

const neverRuns: WorkerRunner = {
  async run(): Promise<WorkerResult> {
    return { ok: false, summary: "测试环境不执行 Worker", exitCode: 1 };
  },
};

export function makeRepo(root: string): string {
  const dir = join(root, "repo");
  mkdirSync(dir);
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

export function startHarness(opts: { beat?: boolean; cfg?: (cfg: Config) => void } = {}): Harness {
  const beat = opts.beat ?? true;
  const root = mkdtempSync(join(tmpdir(), "pisa-api-"));
  const repo = makeRepo(root);
  const stateDir = join(root, ".pisa");
  const cfgPath = join(root, "pisa.config.json");

  const cfg: Config = {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    api: { enabled: true, port: 0 },
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: repo, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir,
  };
  opts.cfg?.(cfg);
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const store = new Store(join(stateDir, "pisa.db"));
  const router = new Router({
    cfg,
    store,
    worker: neverRuns,
    deliverer: new GitDeliverer(cfg),
    channel: new NullChannel(),
  });
  const token = "test-token";
  const api = startApi({ cfg, store, router }, token, 0);
  writeApiInfo(stateDir, { port: api.port, token });

  let timer: ReturnType<typeof setInterval> | undefined;
  if (beat) {
    store.beat();
    timer = setInterval(() => store.beat(), 300);
  }

  return {
    root,
    repo,
    stateDir,
    cfgPath,
    cfg,
    store,
    router,
    port: api.port,
    token,
    stop() {
      clearInterval(timer);
      api.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
