import { afterEach, describe, expect, test } from "bun:test";
import { BOT_COMMANDS } from "../src/config";
import { TelegramChannel } from "../src/channels/telegram";
import type { IncomingMessage } from "../src/types";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("TelegramChannel.setCommands", () => {
  test("调用 setMyCommands 注册菜单命令", async () => {
    const calls: Array<{ url: string; body: { commands: Array<{ command: string; description: string }> } }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof fetch;

    await new TelegramChannel("tok").setCommands(BOT_COMMANDS);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bottok/setMyCommands");
    const names = calls[0]!.body.commands.map((c) => c.command).sort();
    expect(names).toEqual(["cancel", "continue", "help", "merge", "resume", "rewind", "schedules", "status"]);
    expect(calls[0]!.body.commands.every((c) => c.description.length > 0)).toBe(true);
  });
});

describe("TelegramChannel.poll", () => {
  test("编辑消息沿用同一 eventId，并带线程键", async () => {
    const bodies: Array<{ allowed_updates?: string[] }> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { allowed_updates?: string[] });
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 1,
              edited_message: {
                message_id: 12,
                date: 100,
                text: "/pisa 修登录",
                chat: { id: 7, type: "private" },
                from: { id: 8 },
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const channel = new TelegramChannel("tok");
    let resolve!: (m: IncomingMessage) => void;
    const got = new Promise<IncomingMessage>((r) => {
      resolve = r;
    });
    await channel.start(async (m) => {
      resolve(m);
      await channel.stop();
    });

    const msg = await got;
    expect(msg.eventId).toBe("telegram:7:12");
    expect(msg.threadKey).toBe("telegram:7");
    expect(msg.text).toBe("/pisa 修登录");
    expect(msg.chatId).toBe("7");
    expect(bodies[0]?.allowed_updates).toEqual(["message", "edited_message"]);
  });
});
