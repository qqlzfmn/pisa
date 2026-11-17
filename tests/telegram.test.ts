import { afterEach, describe, expect, test } from "bun:test";
import { BOT_COMMANDS } from "../src/config";
import { TelegramChannel, mentionsBot } from "../src/channels/telegram";

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
    expect(names).toEqual(["cancel", "continue", "help", "merge", "policy", "resume", "rewind", "schedules", "status"]);
    expect(calls[0]!.body.commands.every((c) => c.description.length > 0)).toBe(true);
  });
});

describe("mentionsBot", () => {
  test("精确匹配 bot 用户名，区分大小写之外的前后缀", () => {
    expect(mentionsBot("@pisa_bot 修一下", "pisa_bot")).toBe(true);
    expect(mentionsBot("请 @Pisa_Bot 看一下", "pisa_bot")).toBe(true);
    expect(mentionsBot("/pisa @family 修一下", "pisa_bot")).toBe(false);
    expect(mentionsBot("@pisa_bot_extra 修一下", "pisa_bot")).toBe(false);
    expect(mentionsBot("没有点名", "pisa_bot")).toBe(false);
  });
});
