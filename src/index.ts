import { join } from "node:path";
import { loadConfig } from "./config";
import { Store } from "./store";
import { Router } from "./router";
import { OmpWorker } from "./worker";
import { GitDeliverer } from "./deliver";
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
    channel = new TelegramChannel(token);
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
    worker: new OmpWorker(cfg.worker),
    deliverer: new GitDeliverer(cfg),
    channel,
  });

  await channel.start((m) => router.handle(m));
  router.start();
  console.log(`[pisa] ready · channel=${activeChannel.name} · repos=${cfg.repos.map((r) => r.alias).join(",")}`);

  const shutdown = async () => {
    await router.stop();
    await activeChannel.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
