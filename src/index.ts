import { join } from "node:path";
import { BOT_COMMANDS, DEFAULT_ENV_ALLOW, DEFAULT_WEB, githubRepos, loadConfig, type WebConfig } from "./config";
import { Store } from "./store";
import { Router } from "./router";
import { Worker, workerEnv } from "./worker";
import { GitDeliverer } from "./deliver";
import { Proactive } from "./proactive";
import { GithubWatcher } from "./github-watcher";
import { Scheduler } from "./scheduler";
import { Retention } from "./retention";
import { CliChannel } from "./channels/cli";
import { TelegramChannel } from "./channels/telegram";
import { ReplyBus, startWebServer, type WebServer } from "./web";
import type { ChannelAdapter } from "./types";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const wantCli = process.argv.includes("--channel") && process.argv[process.argv.indexOf("--channel") + 1] === "cli";
  // `--web` 强制开启控制台；没有可用通道时回落到 CLI 通道，只当服务宿主
  const web: WebConfig = { ...(cfg.web ?? DEFAULT_WEB), enabled: cfg.web?.enabled === true || process.argv.includes("--web") };

  const store = new Store(join(cfg.stateDir, "pisa.db"));

  let channel: ChannelAdapter;
  if (wantCli) {
    channel = new CliChannel();
  } else if (cfg.channels.telegram?.enabled) {
    const token = process.env[cfg.channels.telegram.tokenEnv];
    if (!token) {
      console.error(`[pisa] 缺少环境变量 ${cfg.channels.telegram.tokenEnv}`);
      process.exit(1);
    }
    channel = new TelegramChannel(token, process.env.PISA_TELEGRAM_PROXY ?? cfg.channels.telegram.proxy);
  } else if (cfg.channels.cli || web.enabled) {
    channel = new CliChannel();
  } else {
    console.error("[pisa] 没有启用的通道");
    process.exit(1);
  }
  const activeChannel = channel;

  // Telegram 命令菜单：失败只告警，不阻断启动
  if (channel.setCommands) {
    try {
      await channel.setCommands(BOT_COMMANDS);
    } catch (err) {
      console.warn(`[pisa] 注册命令菜单失败：${(err as Error).message}`);
    }
  }

  // gh 只认 GH_TOKEN；token 仍来自环境变量，可从 tokenEnv 指定的变量名转交
  const gh = cfg.github;
  if (gh?.enabled && gh.tokenEnv) {
    const token = process.env[gh.tokenEnv];
    if (token) process.env.GH_TOKEN = token;
  }
  // 管理接口总是随守护进程启动：CLI 只认这条通道；web.enabled 只决定 /ui 是否可访问
  cfg.web = web;
  const bus = new ReplyBus(web.chatId, channel);
  const router = new Router({
    cfg,
    store,
    worker: new Worker(cfg.worker, cfg.stateDir),
    deliverer: new GitDeliverer(cfg),
    channel: bus,
  });
  if (!cfg.whitelist.users.includes(web.userId)) {
    console.warn(`[pisa] web.userId=${web.userId} 不在 whitelist.users，管理接口派活会被拒绝`);
  }
  let webServer: WebServer | null = null;
  try {
    webServer = startWebServer({ cfg, store, router, bus }, web);
    console.log(`[pisa] 管理接口 ${webServer.base} · token 见 ${join(cfg.stateDir, "api.token")} 或 ${web.tokenEnv}`);
  } catch (err) {
    // 端口被占用不该拖住任务执行：CLI 会拿到「不可达」，任务照常跑
    console.warn(`[pisa] 管理接口监听 ${web.port} 失败：${(err as Error).message}`);
  }

  const recovered = router.recoverInterrupted();
  if (recovered.paused > 0 || recovered.failed > 0 || recovered.cancelled > 0) {
    console.log(
      `[pisa] 中断任务：${recovered.paused} 个可恢复（paused），${recovered.failed} 个标记 failed，${recovered.cancelled} 个按取消请求置 cancelled`,
    );
  }

  const proactive = new Proactive(cfg, (m) => router.handle(m));
  const githubWatcher = new GithubWatcher({ cfg, store, enqueue: (m) => router.handle(m) });
  const scheduler = new Scheduler({ cfg, store, enqueue: (m) => router.handle(m) });
  const retention = new Retention({ cfg, store });
  router.start();
  proactive.start();
  githubWatcher.start();
  scheduler.start();
  retention.start();
  if (gh?.enabled) {
    const watched = githubRepos(gh).map((r) => r.repo);
    console.log(`[pisa] GitHub 评论轮询已启用 · ${watched.join(", ") || "(无仓库)"}`);
  }

  // 事件入口：CI / 监控 / 脚本可以把任务推进来
  if (cfg.webhook?.enabled) {
    const token = process.env[cfg.webhook.tokenEnv];
    if (!token) {
      console.error(`[pisa] webhook 已启用但缺少 ${cfg.webhook.tokenEnv}`);
    } else {
      Bun.serve({
        port: cfg.webhook.port,
        hostname: "127.0.0.1",
        async fetch(req) {
          if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
          if (req.headers.get("x-pisa-token") !== token) return new Response("forbidden", { status: 403 });
          let body: { prompt?: string; repo?: string; eventId?: string; threadKey?: string; version?: string };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return new Response("bad json", { status: 400 });
          }
          if (!body.prompt) return new Response("prompt required", { status: 400 });
          const eventId = body.eventId ?? `webhook:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
          await router.handle({
            eventId,
            channel: "webhook",
            chatId: cfg.webhook!.chatId,
            userId: cfg.webhook!.userId,
            text: body.prompt,
            repo: body.repo,
            isDirect: true,
            // 调用方带上业务单号就能跨入口命中同一个任务
            threadKey: body.threadKey,
            version: body.version,
          });
          return Response.json({ ok: true, eventId });
        },
      });
      console.log(`[pisa] webhook listening on 127.0.0.1:${cfg.webhook.port}`);
    }
  }
  const allowedEnv = Object.keys(workerEnv(cfg.worker.envAllow ?? DEFAULT_ENV_ALLOW, process.env));
  console.log(`[pisa] Worker 环境白名单 · ${allowedEnv.join(",") || "(空)"}`);
  console.log(`[pisa] ready · channel=${activeChannel.name} · repos=${cfg.repos.map((r) => r.alias).join(",")} · concurrency=${cfg.worker.concurrency}`);

  // 通道放在最后启动：CLI 通道会一直等 stdin 结束，放前面会堵住调度、HTTP 入口与 ready 日志
  await channel.start((m) => {
    proactive.observe(m);
    return router.handle(m);
  });

  // 关停：先停调度（最多等 3 秒让执行中的任务收尾），再停通道与数据库，
  // 最后用退出码 75 退出，由 supervisor 重启；遗留的 running 任务下次启动转 paused。
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (webServer) await webServer.stop();
    await router.stop(3000);
    proactive.stop();
    githubWatcher.stop();
    scheduler.stop();
    retention.stop();
    await activeChannel.stop();
    store.close();
    process.exit(75);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
