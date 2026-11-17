import { describe, expect, test } from "bun:test";
import { webhookHandler } from "../src/webhook";
import type { IncomingMessage } from "../src/types";

const TOKEN = "s3cret-token";
const MAX_BODY_BYTES = 64 * 1024;

function build(now = () => 1_700_000_000_000) {
  const got: IncomingMessage[] = [];
  const handler = webhookHandler({
    token: TOKEN,
    chatId: "c1",
    userId: "u1",
    now,
    handle: async (m) => void got.push(m),
  });
  return { got, handler };
}

function req(
  body: unknown,
  opts: { token?: string | null; headers?: Record<string, string>; raw?: string } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  const token = opts.token === undefined ? TOKEN : opts.token;
  if (token !== null) headers["x-pisa-token"] = token;
  return new Request("http://127.0.0.1:8799/event", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

describe("webhook 事件入口", () => {
  test("webhook 前缀的事件照常投递", async () => {
    const { got, handler } = build();
    const res = await handler(req({ prompt: "跑测试", repo: "pisa", eventId: "webhook:ci:12345" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, eventId: "webhook:ci:12345" });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      eventId: "webhook:ci:12345",
      channel: "webhook",
      chatId: "c1",
      userId: "u1",
      text: "跑测试",
      repo: "pisa",
      isDirect: true,
    });
  });

  test("省略 eventId 时生成 webhook 命名空间的事件", async () => {
    const { got, handler } = build();
    const res = await handler(req({ prompt: "跑测试" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; eventId: string };
    expect(body.eventId).toMatch(/^webhook:1700000000000:[a-z0-9]+$/);
    expect(got[0]?.eventId).toBe(body.eventId);
  });

  test.each(["cron:morning:2026-11-18T09:00", "github:comment:o/r:1", "telegram:1:2", "ci:1"])(
    "拒绝非 webhook 命名空间的事件：%s",
    async (eventId) => {
      const { got, handler } = build();
      const res = await handler(req({ prompt: "跑测试", eventId }));

      expect(res.status).toBe(400);
      expect(got).toHaveLength(0);
    },
  );

  test("token 缺失或长度不等返回 403", async () => {
    const { got, handler } = build();
    for (const token of [null, "short", `${TOKEN}-longer`]) {
      const res = await handler(req({ prompt: "跑测试" }, { token }));
      expect(res.status).toBe(403);
    }
    expect(got).toHaveLength(0);
  });

  test("token 等长但不匹配返回 403", async () => {
    const { got, handler } = build();
    const wrong = "x".repeat(TOKEN.length);
    const res = await handler(req({ prompt: "跑测试" }, { token: wrong }));

    expect(res.status).toBe(403);
    expect(got).toHaveLength(0);
  });

  test("Content-Length 超限返回 413", async () => {
    const { got, handler } = build();
    const raw = `{"prompt":"${"x".repeat(MAX_BODY_BYTES)}"}`;
    const res = await handler(
      req(null, { raw, headers: { "content-length": String(Buffer.byteLength(raw)) } }),
    );

    expect(res.status).toBe(413);
    expect(got).toHaveLength(0);
  });

  test("无 Content-Length 但实际字节超限同样 413", async () => {
    const { got, handler } = build();
    const raw = `{"prompt":"${"x".repeat(MAX_BODY_BYTES)}"}`;
    const res = await handler(req(null, { raw, headers: { "transfer-encoding": "chunked" } }));

    expect(res.status).toBe(413);
    expect(got).toHaveLength(0);
  });

  test("坏 JSON 与缺 prompt 返回 400", async () => {
    const { got, handler } = build();
    expect((await handler(req(null, { raw: "{" }))).status).toBe(400);
    expect((await handler(req({ body: "x" }))).status).toBe(400);
    expect(got).toHaveLength(0);
  });

  test("非 POST 返回 405", async () => {
    const { handler } = build();
    const res = await handler(new Request("http://127.0.0.1:8799/event", { method: "GET" }));
    expect(res.status).toBe(405);
  });
});
