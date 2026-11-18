import { describe, expect, test } from "bun:test";
import { FeishuTrigger } from "../src/triggers/feishu";
import { WecomTrigger } from "../src/triggers/wecom";
import type { TriggerRequest } from "../src/triggers/types";
import {
  FEISHU_KEY,
  FEISHU_TOKEN,
  WECOM_AES_KEY,
  WECOM_CORP,
  WECOM_TOKEN,
  encryptFeishu,
  encryptWecom,
  feishuPayload,
  wecomMessage,
  wecomSignature,
  wecomXml,
} from "./triggers-fixtures";

function feishuRequest(body: string): TriggerRequest {
  return {
    method: "POST",
    url: new URL("http://127.0.0.1/triggers/feishu"),
    headers: new Headers(),
    body,
  };
}

function feishuAdapter(overrides: Partial<ConstructorParameters<typeof FeishuTrigger>[0]> = {}) {
  return new FeishuTrigger({
    verificationToken: FEISHU_TOKEN,
    encryptKey: FEISHU_KEY,
    chatId: "chat-1",
    userId: "u1",
    repo: "demo",
    trigger: "/pisa",
    ...overrides,
  });
}

describe("飞书适配器", () => {
  test("url_verification 回显 challenge", () => {
    const adapter = feishuAdapter({ encryptKey: undefined });
    const req = feishuRequest(JSON.stringify({ type: "url_verification", token: FEISHU_TOKEN, challenge: "ch-1" }));

    expect(adapter.verify(req)).toEqual({ ok: true });
    expect(adapter.normalize(req)).toEqual({
      kind: "reply",
      reply: { status: 200, body: '{"challenge":"ch-1"}', contentType: "application/json; charset=utf-8" },
    });
  });

  test("Verification Token 不匹配返回 403", () => {
    const adapter = feishuAdapter();
    const req = feishuRequest(
      JSON.stringify({ encrypt: encryptFeishu(JSON.stringify(feishuPayload({ token: "wrong" }))) }),
    );
    expect(adapter.verify(req)).toEqual({ ok: false, status: 403, reason: "Verification Token 不匹配" });
  });

  test("加密载荷解密后归一化，正文去掉 @ 占位符", () => {
    const adapter = feishuAdapter();
    const payload = feishuPayload({
      chatType: "group",
      text: "@_user_1 修一下登录",
      mentions: [{ key: "@_user_1" }],
    });
    const req = feishuRequest(JSON.stringify({ encrypt: encryptFeishu(JSON.stringify(payload)) }));

    expect(adapter.verify(req)).toEqual({ ok: true });
    const outcome = adapter.normalize(req);
    if (outcome.kind !== "event") throw new Error(`期望 event，实际 ${outcome.kind}`);
    expect(outcome.payload.text).toBe("修一下登录");
    expect(outcome.payload.externalId).toBe("ev-1");
    expect(outcome.payload.repo).toBe("demo");
    expect(adapter.dedupeKey(outcome.payload)).toBe("feishu:ev-1");
  });

  test("非法 JSON、缺 Encrypt Key、群聊未 @ 机器人都被挡下", () => {
    const adapter = feishuAdapter();
    expect(adapter.verify(feishuRequest('{"encrypt":'))).toEqual({
      ok: false,
      status: 400,
      reason: "载荷不是合法 JSON",
    });

    const noKey = feishuAdapter({ encryptKey: undefined });
    const encrypted = JSON.stringify({ encrypt: encryptFeishu(JSON.stringify(feishuPayload())) });
    expect(noKey.verify(feishuRequest(encrypted))).toEqual({
      ok: false,
      status: 400,
      reason: "载荷已加密但未配置 Encrypt Key",
    });

    expect(adapter.verify(feishuRequest(JSON.stringify(feishuPayload())))).toEqual({
      ok: false,
      status: 400,
      reason: "载荷未加密",
    });

    const plain = feishuAdapter({ encryptKey: undefined });
    const group = feishuRequest(JSON.stringify(feishuPayload({ chatType: "group", text: "修一下登录" })));
    expect(plain.normalize(group)).toEqual({ kind: "ignore", reason: "群消息未 @ 机器人" });

    const broken = feishuRequest(JSON.stringify(feishuPayload({ content: "{not-json" })));
    expect(plain.normalize(broken)).toEqual({
      kind: "reject",
      status: 400,
      reason: "消息 content 不是合法 JSON",
    });
  });

  test("会话与发送者白名单生效", () => {
    const adapter = feishuAdapter({ chats: ["oc-allowed"], users: ["ou-allowed"], encryptKey: undefined });
    expect(adapter.normalize(feishuRequest(JSON.stringify(feishuPayload())))).toEqual({
      kind: "ignore",
      reason: "会话 oc-1 不在白名单",
    });

    const user = feishuRequest(JSON.stringify(feishuPayload({ chatId: "oc-allowed", openId: "ou-other" })));
    expect(adapter.normalize(user)).toEqual({ kind: "ignore", reason: "发送者 ou-other 不在白名单" });
  });

  test("同一 event_id 的重复投递去重键一致", () => {
    const adapter = feishuAdapter({ encryptKey: undefined });
    const body = JSON.stringify(feishuPayload());
    const first = adapter.normalize(feishuRequest(body));
    const second = adapter.normalize(feishuRequest(body));
    if (first.kind !== "event" || second.kind !== "event") throw new Error("期望 event");
    expect(adapter.dedupeKey(first.payload)).toBe(adapter.dedupeKey(second.payload));

    const another = adapter.normalize(feishuRequest(JSON.stringify(feishuPayload({ eventId: "ev-2" }))));
    if (another.kind !== "event") throw new Error("期望 event");
    expect(adapter.dedupeKey(another.payload)).not.toBe(adapter.dedupeKey(first.payload));
  });
});

function wecomAdapter(overrides: Partial<ConstructorParameters<typeof WecomTrigger>[0]> = {}) {
  return new WecomTrigger({
    token: WECOM_TOKEN,
    aesKey: WECOM_AES_KEY,
    corpId: WECOM_CORP,
    chatId: "chat-1",
    userId: "u1",
    repo: "demo",
    ...overrides,
  });
}

function wecomPost(encrypt: string, signature = wecomSignature(encrypt)): TriggerRequest {
  return {
    method: "POST",
    url: new URL(`http://127.0.0.1/triggers/wecom?${signature}`),
    headers: new Headers(),
    body: wecomXml(encrypt),
  };
}

function wecomGet(echo: string): TriggerRequest {
  return {
    method: "GET",
    url: new URL(`http://127.0.0.1/triggers/wecom?${wecomSignature(echo)}&echostr=${encodeURIComponent(echo)}`),
    headers: new Headers(),
    body: "",
  };
}

describe("企业微信适配器", () => {
  test("GET 校验签名并原样返回 echostr", () => {
    const adapter = wecomAdapter();
    const echo = encryptWecom("echo-123");
    const req = wecomGet(echo);

    expect(adapter.verify(req)).toEqual({ ok: true });
    expect(adapter.normalize(req)).toEqual({ kind: "reply", reply: { status: 200, body: "echo-123" } });
  });

  test("POST 签名错误返回 401", () => {
    const adapter = wecomAdapter();
    const req = wecomPost(encryptWecom(wecomMessage()), "msg_signature=bad&timestamp=1&nonce=n");
    expect(adapter.verify(req)).toEqual({ ok: false, status: 401, reason: "签名不匹配" });
  });

  test("合法消息解密成任务事件并回 success", () => {
    const adapter = wecomAdapter();
    const req = wecomPost(encryptWecom(wecomMessage({ msgId: "9001" })));

    expect(adapter.verify(req)).toEqual({ ok: true });
    const outcome = adapter.normalize(req);
    if (outcome.kind !== "event") throw new Error(`期望 event，实际 ${outcome.kind}`);
    expect(outcome.payload.text).toBe("修一下构建");
    expect(outcome.payload.externalId).toBe("9001");
    expect(outcome.ack).toEqual({ status: 200, body: "success" });
    expect(adapter.dedupeKey(outcome.payload)).toBe("wecom:9001");
  });

  test("receiveid 不匹配、解密失败、非文本消息都被挡下", () => {
    const adapter = wecomAdapter();
    const wrongCorp = wecomPost(encryptWecom(wecomMessage(), "other-corp"));
    expect(adapter.normalize(wrongCorp)).toEqual({
      kind: "reject",
      status: 403,
      reason: "receiveid 与企业 ID 不匹配",
    });

    const garbage = Buffer.alloc(32, 1).toString("base64");
    expect(adapter.normalize(wecomPost(garbage))).toEqual({
      kind: "reject",
      status: 400,
      reason: "消息解密失败",
    });

    const image = wecomPost(encryptWecom(wecomMessage({ msgType: "image" })));
    expect(adapter.normalize(image)).toEqual({ kind: "ignore", reason: "暂不支持消息类型 image" });
  });

  test("发送者白名单生效，重复消息去重键一致", () => {
    const adapter = wecomAdapter({ users: ["lisi"] });
    expect(adapter.normalize(wecomPost(encryptWecom(wecomMessage())))).toEqual({
      kind: "ignore",
      reason: "发送者 zhangsan 不在白名单",
    });

    const allowed = wecomAdapter();
    const body = encryptWecom(wecomMessage({ msgId: "9002" }));
    const first = allowed.normalize(wecomPost(body));
    const second = allowed.normalize(wecomPost(body));
    if (first.kind !== "event" || second.kind !== "event") throw new Error("期望 event");
    expect(allowed.dedupeKey(first.payload)).toBe(allowed.dedupeKey(second.payload));
  });
});
