import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv, createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, TriggersConfig } from "../src/config";
import { Store } from "../src/store";
import { makeTrigger } from "../src/trigger";
import {
  feishuSignature,
  FileWatchAdapter,
  makeTriggersHandler,
  wecomSignature,
} from "../src/triggers";
import type { IncomingMessage, Task } from "../src/types";

const NOW = 1_700_000_000_000;
const GH_SECRET = "{{SECRET_gh4d21aa}}";
const FEISHU_SECRET = "{{SECRET_fs9c07bb}}";
const WECOM_TOKEN = "{{SECRET_wt1f7e22}}";
// 32 字节固定的 EncodingAESKey：base64 编码去掉尾部 "=" 正好 43 位
const WECOM_AES = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString("base64").slice(0, 43);
const WECOM_CORP = "ww_corp_1";
const ENV = { GH_SECRET, FEISHU_SECRET, WECOM_TOKEN, WECOM_AES };

function makeCfg(triggers?: TriggersConfig): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: "/tmp/pisa-demo", baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir: "/tmp/pisa-state",
    triggers,
  };
}

function makeHandler(triggers: TriggersConfig, handle: (msg: IncomingMessage) => Promise<void>) {
  return makeTriggersHandler({ cfg: makeCfg(triggers), handle, env: ENV, now: () => NOW });
}

function record(messages: IncomingMessage[]) {
  return async (msg: IncomingMessage): Promise<void> => {
    messages.push(msg);
  };
}

function emptyTask(msg: IncomingMessage): Task {
  const at = msg.receivedAt ?? NOW;
  return {
    id: makeTrigger({
      source: msg.channel,
      threadKey: msg.threadKey ?? `${msg.channel}:${msg.chatId}:${msg.eventId}`,
      messageKey: msg.messageKey ?? msg.eventId,
      actor: msg.actor ?? msg.userId,
      at,
      text: msg.text,
      version: msg.version,
    }).id,
    source: msg.channel,
    channel: msg.channel,
    chatId: msg.chatId,
    requester: msg.userId,
    repo: "demo",
    prompt: msg.text,
    status: "queued",
    branch: null,
    prUrl: null,
    sessionId: null,
    baseRef: null,
    context: null,
    replyPr: null,
    replyIssue: null,
    replyRepo: null,
    summary: null,
    error: null,
    createdAt: at,
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
  };
}

/** 把消息落到真实的去重口上：同 threadKey + messageKey 只建一个任务 */
function persist(store: Store) {
  return async (msg: IncomingMessage): Promise<void> => {
    const task = emptyTask(msg);
    const trigger = makeTrigger({
      source: msg.channel,
      threadKey: msg.threadKey ?? `${msg.channel}:${msg.chatId}:${msg.eventId}`,
      messageKey: msg.messageKey ?? msg.eventId,
      actor: msg.actor ?? msg.userId,
      at: msg.receivedAt ?? NOW,
      text: msg.text,
      version: msg.version,
    });
    store.createTaskFromTrigger(trigger, task);
  };
}

function ghRun(over: { id?: number; conclusion?: string; repo?: string; branch?: string; url?: string } = {}) {
  return {
    action: "completed",
    workflow_run: {
      id: over.id ?? 9001,
      name: "CI",
      path: ".github/workflows/ci.yml",
      head_branch: over.branch ?? "main",
      conclusion: over.conclusion ?? "failure",
      html_url: over.url ?? "https://github.com/acme/web/actions/runs/9001",
      updated_at: "2023-11-14T22:13:20Z",
    },
    repository: { full_name: over.repo ?? "acme/web" },
    sender: { login: "octocat" },
  };
}

function ghRequest(
  body: unknown,
  over: { delivery?: string; event?: string; sig?: string; raw?: string } = {},
): Request {
  const raw = over.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": over.event ?? "workflow_run",
    "x-github-delivery": over.delivery ?? "d-1",
    "x-hub-signature-256": over.sig ?? `sha256=${createHmac("sha256", GH_SECRET).update(raw).digest("hex")}`,
  };
  return new Request("http://127.0.0.1:8790/github/actions", { method: "POST", headers, body: raw });
}

function feishuBody(over: { messageId?: string; chat?: string; openId?: string; text?: string; eventType?: string } = {}) {
  return {
    schema: "2.0",
    header: { event_id: `ev-${over.messageId ?? "om_1"}`, event_type: over.eventType ?? "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: over.openId ?? "ou_1" }, sender_type: "user" },
      message: {
        message_id: over.messageId ?? "om_1",
        chat_id: over.chat ?? "oc_1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: over.text ?? "@_user_1 修一下登录页" }),
      },
    },
  };
}

function feishuRequest(
  body: unknown,
  over: { ts?: string; nonce?: string; sig?: string; raw?: string } = {},
): Request {
  const raw = over.raw ?? JSON.stringify(body);
  const ts = over.ts ?? String(NOW / 1000);
  const nonce = over.nonce ?? "n1";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-lark-request-timestamp": ts,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": over.sig ?? feishuSignature(ts, nonce, FEISHU_SECRET, raw),
  };
  return new Request("http://127.0.0.1:8790/feishu/event", { method: "POST", headers, body: raw });
}

/** 按 WXBizMsgCrypt 格式加密：16 字节随机 + 4 字节长度 + 正文 + 企业号 + 32 字节块补位 */
function wecomEncrypt(xml: string): string {
  const key = Buffer.from(`${WECOM_AES}=`, "base64");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(Buffer.byteLength(xml));
  const raw = Buffer.concat([Buffer.alloc(16, 0xab), length, Buffer.from(xml), Buffer.from(WECOM_CORP)]);
  const pad = 32 - (raw.length % 32);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(pad, pad)])), cipher.final()]).toString("base64");
}

function wecomXml(over: { msgId?: string; from?: string; content?: string; msgType?: string } = {}): string {
  return [
    "<xml>",
    `<ToUserName><![CDATA[${WECOM_CORP}]]></ToUserName>`,
    `<FromUserName><![CDATA[${over.from ?? "zhangsan"}]]></FromUserName>`,
    "<CreateTime>1700000000</CreateTime>",
    `<MsgType><![CDATA[${over.msgType ?? "text"}]]></MsgType>`,
    `<Content><![CDATA[${over.content ?? "修一下登录页"}]]></Content>`,
    `<MsgId>${over.msgId ?? "7298001"}</MsgId>`,
    "<AgentID>1</AgentID>",
    "</xml>",
  ].join("");
}

function wecomRequest(xml: string, over: { encrypt?: string; sig?: string; ts?: string; nonce?: string } = {}): Request {
  const encrypt = over.encrypt ?? wecomEncrypt(xml);
  const ts = over.ts ?? String(NOW / 1000);
  const nonce = over.nonce ?? "n1";
  const sig = over.sig ?? wecomSignature(WECOM_TOKEN, ts, nonce, encrypt);
  return new Request(`http://127.0.0.1:8790/wecom/event?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`, {
    method: "POST",
    body: `<xml><ToUserName><![CDATA[${WECOM_CORP}]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`,
  });
}

describe("GitHub Actions 适配器", () => {
  const on = { chatId: "c1", userId: "u1", githubActions: { enabled: true, secretEnv: "GH_SECRET", repos: ["acme/web"] } };

  test("失败的 workflow_run 归一成任务消息", async () => {
    const messages: IncomingMessage[] = [];
    const res = await makeHandler(on, record(messages))(ghRequest(ghRun()));
    expect(res.status).toBe(200);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.channel).toBe("github-actions");
    expect(msg.text.startsWith("/pisa ")).toBe(true);
    expect(msg.text).toContain("failure");
    expect(msg.text).toContain("acme/web");
    expect(msg.threadKey).toBe("github-actions:acme/web:main");
    expect(msg.messageKey).toBe("github-actions:acme/web:run:9001");
    expect(msg.actor).toBe("octocat");
    expect(msg.isDirect).toBe(true);
  });

  test("签名错误 401、缺签名头 401，都不进任务流", async () => {
    const messages: IncomingMessage[] = [];
    const handler = makeHandler(on, record(messages));
    expect((await handler(ghRequest(ghRun(), { sig: "sha256=deadbeef" }))).status).toBe(401);
    const raw = JSON.stringify(ghRun());
    const unsigned = new Request("http://127.0.0.1:8790/github/actions", {
      method: "POST",
      headers: { "x-github-event": "workflow_run", "x-github-delivery": "d-1" },
      body: raw,
    });
    expect((await handler(unsigned)).status).toBe(401);
    expect(messages).toHaveLength(0);
  });

  test("非法载荷：非 JSON、缺事件头、仓库不在白名单分别 400/400/403", async () => {
    const messages: IncomingMessage[] = [];
    const handler = makeHandler(on, record(messages));
    expect((await handler(ghRequest(null, { raw: "{oops" }))).status).toBe(400);
    expect((await handler(ghRequest(ghRun(), { event: "" }))).status).toBe(400);
    expect((await handler(ghRequest(ghRun({ repo: "other/repo" })))).status).toBe(403);
    expect(messages).toHaveLength(0);
  });

  test("同一次 run 换 delivery 重投只建一个任务", async () => {
    const store = new Store(":memory:");
    try {
      const handler = makeHandler(on, persist(store));
      expect((await handler(ghRequest(ghRun(), { delivery: "d-1" }))).status).toBe(200);
      expect((await handler(ghRequest(ghRun(), { delivery: "d-2" }))).status).toBe(200);
      expect(store.recentTasks()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("成功结论与 ping 回执 200 但不建单", async () => {
    const messages: IncomingMessage[] = [];
    const handler = makeHandler(on, record(messages));
    await handler(ghRequest(ghRun({ conclusion: "success", id: 9100 })));
    await handler(ghRequest({ zen: "hi" }, { event: "ping" }));
    expect(messages).toHaveLength(0);
  });
});

describe("飞书适配器", () => {
  const on = { chatId: "c1", userId: "u1", feishu: { enabled: true, secretEnv: "FEISHU_SECRET", chats: ["oc_1"], users: ["ou_1"] } };

  test("群消息归一成任务，@ 占位被剥掉", async () => {
    const messages: IncomingMessage[] = [];
    const res = await makeHandler(on, record(messages))(feishuRequest(feishuBody()));
    expect(res.status).toBe(200);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.channel).toBe("feishu");
    expect(msg.text).toBe("/pisa 修一下登录页");
    expect(msg.threadKey).toBe("feishu:oc_1");
    expect(msg.messageKey).toBe("feishu:om_1");
    expect(msg.actor).toBe("ou_1");
  });

  test("签名错误与时间戳过窗都 401", async () => {
    const messages: IncomingMessage[] = [];
    const handler = makeHandler(on, record(messages));
    expect((await handler(feishuRequest(feishuBody(), { sig: "0".repeat(64) }))).status).toBe(401);
    const stale = String(NOW / 1000 - 600);
    expect((await handler(feishuRequest(feishuBody(), { ts: stale }))).status).toBe(401);
    expect(messages).toHaveLength(0);
  });

  test("非法载荷：缺 event.message、content 非 JSON 都 400", async () => {
    const messages: IncomingMessage[] = [];
    const handler = makeHandler(on, record(messages));
    expect((await handler(feishuRequest({ header: { event_type: "im.message.receive_v1" }, event: {} }))).status).toBe(400);
    const broken = feishuBody();
    broken.event.message.content = "not-json";
    expect((await handler(feishuRequest(broken))).status).toBe(400);
    expect(messages).toHaveLength(0);
  });

  test("群与发送者白名单拒绝 403", async () => {
    const handler = makeHandler(on, record([]));
    expect((await handler(feishuRequest(feishuBody({ chat: "oc_other" })))).status).toBe(403);
    expect((await handler(feishuRequest(feishuBody({ openId: "ou_other" })))).status).toBe(403);
  });

  test("同一条消息重投只建一个任务", async () => {
    const store = new Store(":memory:");
    try {
      const handler = makeHandler(on, persist(store));
      await handler(feishuRequest(feishuBody(), { nonce: "n1" }));
      await handler(feishuRequest(feishuBody(), { nonce: "n2" }));
      expect(store.recentTasks()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("url_verification 回 challenge 且不建单", async () => {
    const messages: IncomingMessage[] = [];
    const res = await makeHandler(on, record(messages))(
      feishuRequest({ type: "url_verification", challenge: "ch-123", token: "t" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "ch-123" });
    expect(messages).toHaveLength(0);
  });
});

describe("企业微信适配器", () => {
  const on = { chatId: "c1", userId: "u1", wecom: { enabled: true, tokenEnv: "WECOM_TOKEN", aesKeyEnv: "WECOM_AES", users: ["zhangsan"] } };

  test("文本消息归一成任务并回 success", async () => {
    const messages: IncomingMessage[] = [];
    const res = await makeHandler(on, record(messages))(wecomRequest(wecomXml()));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("success");
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.channel).toBe("wecom");
    expect(msg.text).toBe("/pisa 修一下登录页");
    expect(msg.threadKey).toBe("wecom:zhangsan");
    expect(msg.messageKey).toBe("wecom:7298001");
    expect(msg.isDirect).toBe(true);
  });

  test("签名错误与密文损坏都 401", async () => {
    const messages: IncomingMessage[] = [];
    const handler = makeHandler(on, record(messages));
    expect((await handler(wecomRequest(wecomXml(), { sig: "0".repeat(40) }))).status).toBe(401);
    expect((await handler(wecomRequest(wecomXml(), { encrypt: Buffer.alloc(48, 9).toString("base64") }))).status).toBe(401);
    expect(messages).toHaveLength(0);
  });

  test("非法载荷：缺 Encrypt 400、发送者不在白名单 403", async () => {
    const messages: IncomingMessage[] = [];
    const handler = makeHandler(on, record(messages));
    const ts = String(NOW / 1000);
    const empty = new Request(`http://127.0.0.1:8790/wecom/event?msg_signature=x&timestamp=${ts}&nonce=n1`, {
      method: "POST",
      body: "<xml></xml>",
    });
    expect((await handler(empty)).status).toBe(400);
    expect((await handler(wecomRequest(wecomXml({ from: "lisi" })))).status).toBe(403);
    expect(messages).toHaveLength(0);
  });

  test("同一 MsgId 重投只建一个任务", async () => {
    const store = new Store(":memory:");
    try {
      const handler = makeHandler(on, persist(store));
      await handler(wecomRequest(wecomXml()));
      await handler(wecomRequest(wecomXml()));
      expect(store.recentTasks()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("GET echostr 校验回解密后的明文", async () => {
    const handler = makeHandler(on, record([]));
    const echo = wecomEncrypt("echo-ok");
    const sig = wecomSignature(WECOM_TOKEN, String(NOW / 1000), "n1", echo);
    const req = new Request(
      `http://127.0.0.1:8790/wecom/event?msg_signature=${sig}&timestamp=${NOW / 1000}&nonce=n1&echostr=${encodeURIComponent(echo)}`,
    );
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo-ok");
  });
});

describe("文件监听适配器", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("路径缺失时 start 直接抛错", () => {
    const adapter = new FileWatchAdapter({
      config: { enabled: true, paths: [{ path: "/nonexistent/pisa-watch", prompt: "检查 {path}" }] },
      trigger: "/pisa",
      chatId: "c1",
      userId: "u1",
    });
    expect(() => adapter.start(async () => {})).toThrow("文件监听路径不存在");
  });

  test("写入文件后回调收到带路径的任务消息，连续事件去抖成一条", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-watch-"));
    dirs.push(dir);
    const adapter = new FileWatchAdapter({
      config: { enabled: true, debounceMs: 30, paths: [{ path: dir, prompt: "检查 {path}", repo: "demo" }] },
      trigger: "/pisa",
      chatId: "c1",
      userId: "u1",
      repo: "demo",
      now: () => NOW,
    });
    const messages: IncomingMessage[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.start(async (msg) => {
      messages.push(msg);
      release();
    });
    // fs.watch 上报的是平台事件，vi.useFakeTimers 控制不到；只需等在真实事件上，
    // 再用一次去抖窗口的等待确认第二次写入被合并
    try {
      writeFileSync(join(dir, "a.txt"), "1");
      writeFileSync(join(dir, "a.txt"), "2");
      await Promise.race([
        first,
        Bun.sleep(5000).then(() => {
          throw new Error("文件监听未触发");
        }),
      ]);
      await Bun.sleep(120);
    } finally {
      adapter.stop();
    }
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.channel).toBe("file-watch");
    expect(msg.text).toBe(`/pisa 检查 ${join(dir, "a.txt")}`);
    expect(msg.threadKey).toBe(`file-watch:${dir}`);
    expect(msg.messageKey).toBe(`file-watch:${join(dir, "a.txt")}:${NOW}`);
  });

  test("不在监听清单的根路径由 verify 拒绝", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-watch-"));
    dirs.push(dir);
    const adapter = new FileWatchAdapter({
      config: { enabled: true, paths: [{ path: dir, prompt: "检查 {path}" }] },
      trigger: "/pisa",
      chatId: "c1",
      userId: "u1",
    });
    await expect(adapter.verify({ path: join(dir, "x"), root: "/other", event: "change", at: NOW })).rejects.toThrow(
      "路径不在监听清单",
    );
    // 清单内的文件被删掉也要能上报，所以 verify 不看变化文件是否存在
    await expect(adapter.verify({ path: join(dir, "gone.txt"), root: dir, event: "rename", at: NOW })).resolves.toBeDefined();
  });
});

describe("触发入口装配", () => {
  test("未启用的路径返回 404", async () => {
    const res = await makeHandler({}, record([]))(ghRequest(ghRun()));
    expect(res.status).toBe(404);
  });

  test("启用但缺 chatId/userId 时装配即失败", () => {
    expect(() =>
      makeTriggersHandler({
        cfg: makeCfg({ githubActions: { enabled: true, secretEnv: "GH_SECRET" } }),
        handle: record([]),
        env: ENV,
      }),
    ).toThrow("triggers.chatId");
  });

  test("密钥缺失时入口回 503", async () => {
    const res = await makeTriggersHandler({
      cfg: makeCfg({ chatId: "c1", userId: "u1", githubActions: { enabled: true, secretEnv: "MISSING_ENV" } }),
      handle: record([]),
      env: ENV,
      now: () => NOW,
    })(ghRequest(ghRun()));
    expect(res.status).toBe(503);
  });
});
