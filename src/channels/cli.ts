import type { ChannelAdapter, IncomingMessage } from "../types";

type Handler = (m: IncomingMessage) => Promise<void> | void;

/** 本地通道：stdin 一行一条消息，stdout 打回执 */
export class CliChannel implements ChannelAdapter {
  name = "cli";
  private stopped = false;

  constructor(private userId = process.env.USER ?? "local") {}

  async start(onMessage: Handler): Promise<void> {
    process.stdin.setEncoding("utf8");
    let buf = "";
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        void onMessage({
          eventId: `cli:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          channel: "cli",
          chatId: "local",
          userId: this.userId,
          text,
          receivedAt: Date.now(),
        });
      }
    });
    // 保持事件循环，不阻塞调用方
    await new Promise<void>((resolve) => {
      process.stdin.on("end", () => resolve());
    });
  }

  async send(_chatId: string, text: string): Promise<void> {
    process.stdout.write(text + "\n");
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
