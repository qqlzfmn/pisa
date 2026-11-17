#!/usr/bin/env bun
import { resolve } from "node:path";
import { loadConfigSafe, type Config } from "./config";
import { TelegramChannel } from "./channels/telegram";
import { formatReport, inspect, shouldSpeak } from "./health";

const USAGE = `用法：
  pisa status [--alert]

退出码：0 正常 / 1 需重启 / 2 部件错误 / 3 待配置
  status   打印健康报告，退出码即结论
  --alert  巡检模式：正常时静默；异常且与上次问题不同才输出并推送`;

/** 巡检推送：配置了 Telegram 与投递目标才发，失败不影响退出码 */
async function notify(cfg: Config, text: string): Promise<void> {
  const telegram = cfg.channels.telegram;
  if (!telegram?.enabled) return;
  const token = process.env[telegram.tokenEnv];
  const chatId = cfg.scheduler?.chatId ?? cfg.proactive?.probe?.chatId ?? cfg.webhook?.chatId;
  if (!token || !chatId) return;
  try {
    await new TelegramChannel(token, process.env.PISA_TELEGRAM_PROXY ?? telegram.proxy).send(chatId, text);
  } catch (err) {
    console.error(`[pisa] 状态通知发送失败：${(err as Error).message}`);
  }
}

async function status(args: string[]): Promise<number> {
  if (args.some((a) => a !== "--alert")) {
    console.log(USAGE);
    return 64;
  }
  const configFile = resolve(process.env.PISA_CONFIG ?? "pisa.config.json");
  const { cfg, error } = loadConfigSafe(configFile);
  const report = inspect({ cfg, configFile, configError: error });
  const alert = args.includes("--alert");

  // 巡检模式先过一遍去重；手动查看每次完整输出
  if (alert && !shouldSpeak(cfg.stateDir, report)) return report.code;

  const text = formatReport(report);
  console.log(text);
  if (alert && report.code !== 0) await notify(cfg, text);
  return report.code;
}

const [command, ...rest] = process.argv.slice(2);
if (command === "status") {
  process.exitCode = await status(rest);
} else {
  console.log(USAGE);
  process.exitCode = 64;
}
