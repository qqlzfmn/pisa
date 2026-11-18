import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { sh } from "../src/git";
import type { ChannelAdapter, IncomingMessage, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { GithubActionsAdapter } from "../src/triggers/github-actions";
import { FeishuAdapter } from "../src/triggers/feishu";
import { WecomAdapter } from "../src/triggers/wecom";
import { buildTriggerAdapters } from "../src/triggers/index";
import { createTriggerHandler } from "../src/triggers/server";
import type { TriggerEvent, TriggerOutcome, TriggerRequest } from "../src/triggers/types";

const GH_SECRET = "gh-secret";
const FEISHU_KEY = "feishu-encrypt-key";
const FEISHU_NOW = 1_700_000_000_000;
const WECOM_TOKEN = "wecom-token";
const WECOM_AES = randomBytes(32).toString("base64").slice(0, 43);
const WECOM_CORP = "ww-corpid";

interface FakeRequest {
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string;
}

function req(over: FakeRequest = {}): TriggerRequest {
  return {
    method: over.method ?? "POST",
    headers: new Headers(over.headers ?? {}),
    query: new URLSearchParams(over.query ?? {}),
    body: over.body ?? "",
  };
}

function cfg(over: Partial<Config> = {}): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [],
    worker: { adapter: "omp", command: "omp", timeoutSec: 60, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir: tmpdir(),
    triggers: { port: 18899, chatId: "c1", userId: "u1" },
    ...over,
  };
}

// ---------- GitHub Actions ----------

function runPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "completed",
    repository: { full_name: "acme/app" },
    workflow_run: {
      id: 42,
      name: "ci",
      conclusion: "failure",
      head_branch: "main",
      html_url: "https://github.com/acme/app/actions/runs/42",
      run_attempt: 1,
      updated_at: "2026-11-18T06:00:00Z",
    },
    sender: { login: "octocat" },
    ...over,
  };
}

function ghRequest(body: unknown, over: { signature?: string; event?: string } = {}): TriggerRequest {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = over.signature ?? `sha256=${createHmac("sha256", GH_SECRET).update(raw).digest("hex")}`;
  return req({
    body: raw,
    headers: { "x-hub-signature-256": signature, "x-github-event": over.event ?? "workflow_run" },
  });
}

function ghAdapter(over: { repos?: string[]; workflows?: string[] } = {}): GithubActionsAdapter {
  return new GithubActionsAdapter({
    secret: GH_SECRET,
    repos: over.repos ?? ["acme/app"],
    workflows: over.workflows,
    repo: "demo",
  });
}

function eventOf(outcome: TriggerOutcome): TriggerEvent {
  if (outcome.kind !== "event") throw new Error(`期望 event，实际 ${outcome.kind}`);
  return outcome.event;
}

describe("GitHub Actions 适配器", () => {
  test("签名不符或缺失都拒绝", () => {
    const adapter = ghAdapter();
    expect(adapter.verify(ghRequest(runPayload()))).toBeNull();
    expect(adapter.verify(ghRequest(runPayload(), { signature: "sha256=deadbeef" }))).toBe("签名不匹配");
    expect(adapter.verify(req({ body: "{}" }))).toBe("缺少 X-Hub-Signature-256");
  });

  test("重复投递得到同一个去重键", () => {
    const adapter = ghAdapter();
    const first = eventOf(adapter.normalize(ghRequest(runPayload())));
    const repeat = eventOf(adapter.normalize(ghRequest(runPayload())));
    expect(adapter.dedupeKey(first)).toBe(adapter.dedupeKey(repeat));
    expect(first.threadKey).toBe("github-actions:acme/app:run:42");
    expect(first.messageKey).toBe("run:42:1");
    // 重跑是新的尝试，另开一单
    const retry = eventOf(adapter.normalize(ghRequest(runPayload({ workflow_run: { ...(runPayload().workflow_run as object), run_attempt: 2 } }))));
    expect(adapter.dedupeKey(retry)).not.toBe(adapter.dedupeKey(first));
  });

  test("非法载荷与非失败结论", () => {
    const adapter = ghAdapter();
    expect(adapter.normalize(ghRequest("not json")).kind).toBe("reject");
    expect(adapter.normalize(ghRequest({ action: "completed" })).kind).toBe("reject");
    const noId = runPayload({ workflow_run: { conclusion: "failure", name: "ci" } });
    expect(adapter.normalize(ghRequest(noId)).kind).toBe("reject");
    expect(adapter.normalize(ghRequest(runPayload({ action: "requested" }))).kind).toBe("ignore");
    const passed = runPayload({ workflow_run: { ...(runPayload().workflow_run as object), conclusion: "success" } });
    expect(adapter.normalize(ghRequest(passed)).kind).toBe("ignore");
    expect(adapter.normalize(ghRequest(runPayload(), { event: "issues" })).kind).toBe("ignore");
  });

  test("仓库与 workflow 白名单", () => {
    const adapter = ghAdapter({ workflows: ["ci"] });
    expect(adapter.normalize(ghRequest(runPayload({ repository: { full_name: "other/repo" } }))).kind).toBe("ignore");
    const otherWorkflow = runPayload({ workflow_run: { ...(runPayload().workflow_run as object), name: "deploy" } });
    expect(adapter.normalize(ghRequest(otherWorkflow)).kind).toBe("ignore");
  });
});

// ---------- 飞书 ----------

function feishuSign(timestamp: string, nonce: string, body: string): string {
  return createHash("sha256").update(timestamp + nonce + FEISHU_KEY + body).digest("hex");
}

function feishuEncrypt(plain: string): string {
  const key = createHash("sha256").update(FEISHU_KEY).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}

function feishuPayload(over: { text?: string; chatId?: string; messageId?: string; messageType?: string } = {}): Record<string, unknown> {
  return {
    schema: "2.0",
    header: { event_id: "ev-1", event_type: "im.message.receive_v1", create_time: "1700000000000" },
    event: {
      sender: { sender_id: { open_id: "ou_1" } },
      message: {
        message_id: over.messageId ?? "om_1",
        chat_id: over.chatId ?? "oc_1",
        message_type: over.messageType ?? "text",
        content: JSON.stringify({ text: over.text ?? "@_user_1 修复登录" }),
        create_time: "1700000000000",
      },
    },
  };
}

function feishuRequest(body: unknown, over: { signature?: string; timestamp?: string } = {}): TriggerRequest {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = over.timestamp ?? String(FEISHU_NOW / 1000);
  const nonce = "nonce-1";
  return req({
    body: raw,
    headers: {
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": over.signature ?? feishuSign(timestamp, nonce, raw),
    },
  });
}

function feishuAdapter(over: { chats?: string[]; users?: string[] } = {}): FeishuAdapter {
  return new FeishuAdapter(
    { encryptKey: FEISHU_KEY, chats: over.chats ?? ["oc_1"], users: over.users, repo: "demo" },
    () => FEISHU_NOW,
  );
}

describe("飞书适配器", () => {
  test("签名不符、时间戳过期都拒绝", () => {
    const adapter = feishuAdapter();
    expect(adapter.verify(feishuRequest(feishuPayload()))).toBeNull();
    expect(adapter.verify(feishuRequest(feishuPayload(), { signature: "0".repeat(64) }))).toBe("签名不匹配");
    expect(adapter.verify(feishuRequest(feishuPayload(), { timestamp: "1600000000" }))).toBe("请求时间戳超出允许窗口");
    expect(adapter.verify(req({ body: "{}" }))).toBe("缺少飞书签名头");
  });

  test("重复投递得到同一个去重键，@ 占位符被去掉", () => {
    const adapter = feishuAdapter();
    const first = eventOf(adapter.normalize(feishuRequest(feishuPayload())));
    const repeat = eventOf(adapter.normalize(feishuRequest(feishuPayload())));
    expect(first.text).toBe("修复登录");
    expect(first.threadKey).toBe("feishu:oc_1");
    expect(adapter.dedupeKey(first)).toBe(adapter.dedupeKey(repeat));
  });

  test("加密载荷与握手", () => {
    const adapter = feishuAdapter();
    const plain = JSON.stringify(feishuPayload({ messageId: "om_2" }));
    const encrypted = feishuRequest({ encrypt: feishuEncrypt(plain) });
    expect(eventOf(adapter.normalize(encrypted)).messageKey).toBe("om_2");
    const handshake = feishuRequest({ type: "url_verification", challenge: "abc" });
    expect(adapter.normalize(handshake)).toEqual({
      kind: "challenge",
      body: JSON.stringify({ challenge: "abc" }),
      contentType: "application/json",
    });
    expect(adapter.normalize(feishuRequest({ encrypt: "not-base64" })).kind).toBe("reject");
  });

  test("非法载荷、白名单与消息类型", () => {
    const adapter = feishuAdapter();
    expect(adapter.normalize(feishuRequest("not json")).kind).toBe("reject");
    expect(adapter.normalize(feishuRequest({ header: { event_type: "im.message.receive_v1" } })).kind).toBe("reject");
    expect(adapter.normalize(feishuRequest(feishuPayload({ chatId: "oc_other" }))).kind).toBe("ignore");
    expect(adapter.normalize(feishuRequest(feishuPayload({ messageType: "image" }))).kind).toBe("ignore");
    expect(adapter.normalize(feishuRequest(feishuPayload({ text: "@_user_1 " }))).kind).toBe("ignore");
    const limited = feishuAdapter({ users: ["ou_2"] });
    expect(limited.normalize(feishuRequest(feishuPayload())).kind).toBe("ignore");
  });
});

// ---------- 企业微信 ----------

function wecomSign(timestamp: string, nonce: string, encrypted: string): string {
  return createHash("sha1").update([WECOM_TOKEN, timestamp, nonce, encrypted].sort().join("")).digest("hex");
}

function wecomEncrypt(message: string): string {
  const key = Buffer.from(`${WECOM_AES}=`, "base64");
  const body = Buffer.from(message, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const raw = Buffer.concat([randomBytes(16), length, body, Buffer.from(WECOM_CORP, "utf8")]);
  const pad = 32 - (raw.length % 32);
  const plain = Buffer.concat([raw, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString("base64");
}

function wecomXml(over: { content?: string; from?: string; msgId?: string; msgType?: string } = {}): string {
  return [
    "<xml>",
    "<ToUserName><![CDATA[ww-corpid]]></ToUserName>",
    `<FromUserName><![CDATA[${over.from ?? "zhangsan"}]]></FromUserName>`,
    "<CreateTime>1700000000</CreateTime>",
    `<MsgType><![CDATA[${over.msgType ?? "text"}]]></MsgType>`,
    `<Content><![CDATA[${over.content ?? "修复登录"}]]></Content>`,
    `<MsgId>${over.msgId ?? "7001"}</MsgId>`,
    "<AgentID>1000002</AgentID>",
    "</xml>",
  ].join("");
}

function wecomPost(xml: string, over: { signature?: string } = {}): { request: TriggerRequest; encrypted: string } {
  const encrypted = wecomEncrypt(xml);
  const timestamp = "1700000000";
  const nonce = "n1";
  const signature = over.signature ?? wecomSign(timestamp, nonce, encrypted);
  const body = `<xml><ToUserName><![CDATA[ww-corpid]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`;
  return {
    request: req({ body, query: { msg_signature: signature, timestamp, nonce } }),
    encrypted,
  };
}

function wecomAdapter(over: { users?: string[] } = {}): WecomAdapter {
  return new WecomAdapter({
    token: WECOM_TOKEN,
    aesKey: WECOM_AES,
    corpId: WECOM_CORP,
    users: over.users ?? ["zhangsan"],
    repo: "demo",
  });
}

describe("企业微信适配器", () => {
  test("签名不符或缺失都拒绝", () => {
    const adapter = wecomAdapter();
    const ok = wecomPost(wecomXml());
    expect(adapter.verify(ok.request)).toBeNull();
    expect(adapter.verify(req({ body: ok.request.body }))).toBe("缺少 msg_signature / timestamp / nonce");
    const bad = wecomPost(wecomXml(), { signature: "0".repeat(40) });
    expect(adapter.verify(bad.request)).toBe("签名不匹配");
  });

  test("重复投递得到同一个去重键", () => {
    const adapter = wecomAdapter();
    const first = eventOf(adapter.normalize(wecomPost(wecomXml()).request));
    const repeat = eventOf(adapter.normalize(wecomPost(wecomXml()).request));
    expect(first.threadKey).toBe("wecom:zhangsan");
    expect(first.messageKey).toBe("7001");
    expect(adapter.dedupeKey(first)).toBe(adapter.dedupeKey(repeat));
  });

  test("GET 握手返回解密后的 echostr", () => {
    const adapter = wecomAdapter();
    const echostr = wecomEncrypt("echo-123");
    const timestamp = "1700000000";
    const nonce = "n1";
    const request = req({
      method: "GET",
      query: { msg_signature: wecomSign(timestamp, nonce, echostr), timestamp, nonce, echostr },
    });
    expect(adapter.verify(request)).toBeNull();
    expect(adapter.normalize(request)).toEqual({ kind: "challenge", body: "echo-123" });
  });

  test("非法载荷、corpid 不匹配与白名单", () => {
    const adapter = wecomAdapter();
    expect(adapter.normalize(wecomPost("<xml><MsgType><![CDATA[image]]></MsgType></xml>").request).kind).toBe("ignore");
    expect(adapter.normalize(wecomPost("<xml><MsgType><![CDATA[text]]></MsgType></xml>").request).kind).toBe("reject");
    // 用别的企业 ID 加密：corpid 校验失败
    const key = Buffer.from(`${WECOM_AES}=`, "base64");
    const body = Buffer.from("hello");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const raw = Buffer.concat([randomBytes(16), length, body, Buffer.from("other-corp", "utf8")]);
    const pad = 32 - (raw.length % 32);
    const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
    cipher.setAutoPadding(false);
    const wrongCorp = Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(pad, pad)])), cipher.final()]).toString("base64");
    const envelope = `<xml><Encrypt><![CDATA[${wrongCorp}]]></Encrypt></xml>`;
    const normalized = adapter.normalize(wecomPost(envelope).request);
    expect(normalized.kind).toBe("reject");
    expect(adapter.normalize(wecomPost(wecomXml({ from: "lisi" })).request).kind).toBe("ignore");
  });
});

// ---------- 配置装配与 HTTP 入口 ----------

describe("装配与 HTTP 入口", () => {
  test("没有配置或没有密钥时不启用，密钥就绪后按适配器名暴露", () => {
    expect(buildTriggerAdapters(cfg())).toEqual([]);
    process.env.PISA_TEST_GH_SECRET = GH_SECRET;
    process.env.PISA_TEST_FEISHU_KEY = FEISHU_KEY;
    try {
      const enabled = cfg({
        triggers: {
          port: 18899,
          chatId: "c1",
          userId: "u1",
          githubActions: { enabled: true, secretEnv: "PISA_TEST_GH_SECRET", repos: ["acme/app"] },
          feishu: { enabled: true, encryptKeyEnv: "PISA_TEST_FEISHU_KEY", chats: ["oc_1"] },
          wecom: { enabled: true, tokenEnv: "PISA_TEST_MISSING", aesKeyEnv: "PISA_TEST_MISSING", corpId: WECOM_CORP, users: [] },
        },
      });
      expect(buildTriggerAdapters(enabled).map((adapter) => adapter.name)).toEqual(["github-actions", "feishu"]);
    } finally {
      delete process.env.PISA_TEST_GH_SECRET;
      delete process.env.PISA_TEST_FEISHU_KEY;
    }
  });

  test("入口按状态码响应，并把事件映射成 core 的消息", async () => {
    const got: IncomingMessage[] = [];
    const handler = createTriggerHandler({ cfg: cfg(), adapters: [ghAdapter()], handle: (m) => void got.push(m) });
    const url = "http://127.0.0.1:18899/triggers/github-actions";

    const missing = await handler(new Request("http://127.0.0.1:18899/triggers/nope", { method: "POST", body: "{}" }));
    expect(missing.status).toBe(404);

    const disabled = createTriggerHandler({ cfg: cfg({ triggers: undefined }), adapters: [ghAdapter()], handle: (m) => void got.push(m) });
    expect((await disabled(new Request(url, { method: "POST", body: "{}" }))).status).toBe(404);

    const forged = await handler(
      new Request(url, {
        method: "POST",
        body: JSON.stringify(runPayload()),
        headers: { "x-github-event": "workflow_run", "x-hub-signature-256": "sha256=deadbeef" },
      }),
    );
    expect(forged.status).toBe(401);
    expect(got).toHaveLength(0);

    const raw = JSON.stringify(runPayload());
    const good = await handler(ghRequestRequest(url, raw));
    expect(good.status).toBe(200);
    expect(got).toHaveLength(1);
    expect(got[0]!).toMatchObject({
      channel: "github-actions",
      chatId: "c1",
      userId: "u1",
      repo: "demo",
      isDirect: true,
      admin: true,
      threadKey: "github-actions:acme/app:run:42",
      messageKey: "run:42:1",
      actor: "octocat",
    });
    expect(got[0]!.text.startsWith("/pisa CI 失败")).toBe(true);

    const ignored = await handler(
      new Request(url, {
        method: "POST",
        body: JSON.stringify(runPayload({ action: "requested" })),
        headers: {
          "x-github-event": "workflow_run",
          "x-hub-signature-256": `sha256=${createHmac("sha256", GH_SECRET).update(JSON.stringify(runPayload({ action: "requested" }))).digest("hex")}`,
        },
      }),
    );
    expect(ignored.status).toBe(200);
    expect((await ignored.json()) as { ignored: string }).toMatchObject({ ignored: expect.stringContaining("不处理") });
    expect(got).toHaveLength(1);
  });

  test("同一事件投两次只建一个任务", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pisa-trigger-"));
    const repoPath = join(dir, "repo");
    sh(["git", "init", "-q", "-b", "main", repoPath]);
    writeFileSync(join(repoPath, "README.md"), "hello\n");
    sh(["git", "-C", repoPath, "add", "-A"]);
    sh(["git", "-C", repoPath, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);

    const store = new Store(join(dir, "pisa.db"));
    const channel: ChannelAdapter = {
      name: "fake",
      async start() {},
      async send() {
        return { messageId: "1" };
      },
      async stop() {},
    };
    const worker: WorkerRunner = {
      async run(): Promise<WorkerResult> {
        return { ok: true, summary: "ok", exitCode: 0 };
      },
    };
    const routerCfg = cfg({
      repos: [{ alias: "demo", path: repoPath, baseBranch: "main" }],
      stateDir: dir,
    });
    const router = new Router({ cfg: routerCfg, store, worker, deliverer: new GitDeliverer(routerCfg), channel });
    const handler = createTriggerHandler({
      cfg: routerCfg,
      adapters: [ghAdapter()],
      handle: (m) => router.handle(m),
    });
    const url = "http://127.0.0.1:18899/triggers/github-actions";
    const first = await handler(ghRequestRequest(url, JSON.stringify(runPayload())));
    const second = await handler(ghRequestRequest(url, JSON.stringify(runPayload())));
    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string };
    expect(firstBody.id).toBe(secondBody.id);
    expect(store.listTasks().length).toBe(1);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

function ghRequestRequest(url: string, raw: string): Request {
  return new Request(url, {
    method: "POST",
    body: raw,
    headers: {
      "x-github-event": "workflow_run",
      "x-hub-signature-256": `sha256=${createHmac("sha256", GH_SECRET).update(raw).digest("hex")}`,
    },
  });
}
