import { join } from "node:path";
import { loadConfig } from "./config";
import { Store } from "./store";
import { Router } from "./router";
import { Worker } from "./worker";
import { GitDeliverer } from "./deliver";
import { Proactive } from "./proactive";
import { CliChannel } from "./channels/cli";
import { TelegramChannel } from "./channels/telegram";
import type { ChannelAdapter } from "./types";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const wantCli = process.argv.includes("--channel") && process.argv[process.argv.indexOf("--channel") + 1] === "cli";

  const store = new Store(join(cfg.stateDir, "pisa.db"));
  const orphans = store.markOrphansFailed("进程重启，任务中断");
  if (orphans > 0) console.log(`[pisa] ${orphans} 个中断任务已标记为 failed`);

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
  } else if (cfg.channels.cli) {
    channel = new CliChannel();
  } else {
    console.error("[pisa] 没有启用的通道");
    process.exit(1);
  }
  const activeChannel = channel;

  const router = new Router({
    cfg,
    store,
    worker: new Worker(cfg.worker, cfg.stateDir),
    deliverer: new GitDeliverer(cfg),
    channel,
  });

  const proactive = new Proactive(cfg, (m) => router.handle(m));
  await channel.start((m) => {
    proactive.observe(m);
    return router.handle(m);
  });
  router.start();
  proactive.start();

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
          let body: { prompt?: string; repo?: string; eventId?: string };
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
          });
          return Response.json({ ok: true, eventId });
        },
      });
      console.log(`[pisa] webhook listening on 127.0.0.1:${cfg.webhook.port}`);
    }
  }
  console.log(`[pisa] ready · channel=${activeChannel.name} · repos=${cfg.repos.map((r) => r.alias).join(",")} · concurrency=${cfg.worker.concurrency}`);

  const shutdown = async () => {
    proactive.stop();
    await router.stop();
    await activeChannel.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
