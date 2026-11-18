import { describe, expect, test } from "bun:test";
import { createTriggerAdapters, createTriggerHandler } from "../src/triggers";
import { GithubActionsTrigger } from "../src/triggers/github";
import type { TriggerAdapter } from "../src/triggers/types";
import type { IncomingMessage } from "../src/types";
import {
  FEISHU_KEY,
  FEISHU_TOKEN,
  GITHUB_SECRET,
  WECOM_AES_KEY,
  WECOM_CORP,
  WECOM_TOKEN,
  baseConfig,
  encryptFeishu,
  encryptWecom,
  feishuPayload,
  signGithub,
  wecomMessage,
  wecomSignature,
  wecomXml,
} from "./triggers-fixtures";

function handlerFor(adapters: TriggerAdapter[], received: IncomingMessage[]) {
  return createTriggerHandler({
    adapters,
    trigger: "/pisa",
    handle: (message) => {
      received.push(message);
    },
    now: () => 1_700_000_000_000,
  });
}

const ghAdapter = new GithubActionsTrigger({
  secret: GITHUB_SECRET,
  chatId: "chat-1",
  userId: "u1",
  repo: "demo",
});

const failedRun = JSON.stringify({
  action: "completed",
  repository: { full_name: "acme/pisa" },
  workflow_run: {
    id: 42,
    name: "CI",
    head_branch: "main",
    run_number: 7,
    run_attempt: 1,
    conclusion: "failure",
  },
});

function githubCall(body = failedRun): Request {
  return new Request("http://127.0.0.1/triggers/github-actions", {
    method: "POST",
    headers: {
      "x-github-event": "workflow_run",
      "x-hub-signature-256": signGithub(body),
    },
    body,
  });
}

describe("/triggers 分发", () => {
  test("合法事件转成带触发词的 IncomingMessage", async () => {
    const received: IncomingMessage[] = [];
    const res = await handlerFor([ghAdapter], received)(githubCall());
    expect(res.status).toBe(202);

    const body = (await res.json()) as { ok: boolean; eventId: string };
    expect(body.eventId).toBe("github-actions:acme/pisa:42:1");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      eventId: "github-actions:acme/pisa:42:1",
      channel: "github-actions",
      chatId: "chat-1",
      userId: "u1",
      repo: "demo",
      isDirect: true,
      receivedAt: 1_700_000_000_000,
    });
    expect(received[0]!.text.startsWith("/pisa ")).toBe(true);
  });

  test("相同投递两次得到同一 eventId，交由 Router 去重", async () => {
    const received: IncomingMessage[] = [];
    const handler = handlerFor([ghAdapter], received);
    await handler(githubCall());
    await handler(githubCall());
    expect(received).toHaveLength(2);
    expect(received[0]!.eventId).toBe(received[1]!.eventId);
  });

  test("签名失败不进入 Router，未知路径与超大包被拒绝", async () => {
    const received: IncomingMessage[] = [];
    const handler = handlerFor([ghAdapter], received);

    const forged = new Request("http://127.0.0.1/triggers/github-actions", {
      method: "POST",
      headers: { "x-github-event": "workflow_run", "x-hub-signature-256": "sha256=bad" },
      body: failedRun,
    });
    const rejected = await handler(forged);
    expect(rejected.status).toBe(401);
    expect(received).toHaveLength(0);

    const missing = await handler(new Request("http://127.0.0.1/triggers/unknown", { method: "POST", body: "{}" }));
    expect(missing.status).toBe(404);

    const huge = await handler(
      new Request("http://127.0.0.1/triggers/github-actions", { method: "POST", body: "x".repeat(300 * 1024) }),
    );
    expect(huge.status).toBe(413);
  });

  test("飞书 challenge 与企业微信 success 由适配器自己的响应返回", async () => {
    const cfg = baseConfig();
    cfg.triggers = {
      enabled: true,
      port: 8798,
      feishu: { enabled: true, verificationTokenEnv: "FEISHU_TOKEN_ENV", chatId: "chat-1", userId: "u1", repo: "demo" },
      wecom: {
        enabled: true,
        tokenEnv: "WECOM_TOKEN_ENV",
        aesKeyEnv: "WECOM_AES_KEY_ENV",
        corpId: WECOM_CORP,
        chatId: "chat-1",
        userId: "u1",
        repo: "demo",
      },
    };
    const { adapters } = createTriggerAdapters(cfg, {
      FEISHU_TOKEN_ENV: FEISHU_TOKEN,
      WECOM_TOKEN_ENV: WECOM_TOKEN,
      WECOM_AES_KEY_ENV: WECOM_AES_KEY,
    });
    expect(adapters.map((a) => a.name)).toEqual(["feishu", "wecom"]);
    const received: IncomingMessage[] = [];
    const handler = handlerFor(adapters, received);

    const challenge = await handler(
      new Request("http://127.0.0.1/triggers/feishu", {
        method: "POST",
        body: JSON.stringify({ type: "url_verification", token: FEISHU_TOKEN, challenge: "ch-9" }),
      }),
    );
    expect(await challenge.json()).toEqual({ challenge: "ch-9" });

    const encrypted = encryptWecom(wecomMessage({ msgId: "9100" }));
    const wecom = await handler(
      new Request(`http://127.0.0.1/triggers/wecom?${wecomSignature(encrypted)}`, {
        method: "POST",
        body: wecomXml(encrypted),
      }),
    );
    expect(wecom.status).toBe(200);
    expect(await wecom.text()).toBe("success");
    expect(received[0]!.eventId).toBe("wecom:9100");
  });

  test("飞书加密事件能穿过分发层", async () => {
    const cfg = baseConfig();
    cfg.triggers = {
      enabled: true,
      port: 8798,
      feishu: {
        enabled: true,
        verificationTokenEnv: "FEISHU_TOKEN_ENV",
        encryptKeyEnv: "FEISHU_KEY_ENV",
        chatId: "chat-1",
        userId: "u1",
      },
    };
    const { adapters } = createTriggerAdapters(cfg, {
      FEISHU_TOKEN_ENV: FEISHU_TOKEN,
      FEISHU_KEY_ENV: FEISHU_KEY,
    });
    const received: IncomingMessage[] = [];
    const body = JSON.stringify({ encrypt: encryptFeishu(JSON.stringify(feishuPayload({ eventId: "ev-9" }))) });

    const res = await handlerFor(adapters, received)(
      new Request("http://127.0.0.1/triggers/feishu", { method: "POST", body }),
    );
    expect(res.status).toBe(202);
    expect(received[0]!.eventId).toBe("feishu:ev-9");
  });
});

describe("触发器装配", () => {
  test("总开关关闭时不装任何适配器", () => {
    const cfg = baseConfig();
    cfg.triggers = { enabled: false, port: 8798, githubActions: { enabled: true, secretEnv: "S", chatId: "c", userId: "u" } };
    expect(createTriggerAdapters(cfg, { S: GITHUB_SECRET })).toEqual({ adapters: [], warnings: [] });
  });

  test("凭据缺失时跳过该来源并给出告警，其余来源照常启用", () => {
    const cfg = baseConfig();
    cfg.triggers = {
      enabled: true,
      port: 8798,
      githubActions: { enabled: true, secretEnv: "GH_SECRET_ENV", chatId: "chat-1", userId: "u1" },
      wecom: {
        enabled: true,
        tokenEnv: "WECOM_TOKEN_ENV",
        aesKeyEnv: "WECOM_AES_KEY_ENV",
        corpId: WECOM_CORP,
        chatId: "chat-1",
        userId: "u1",
      },
    };
    const setup = createTriggerAdapters(cfg, {});
    expect(setup.adapters).toEqual([]);
    expect(setup.warnings).toEqual([
      "triggers.githubActions 已启用，但环境变量 GH_SECRET_ENV 为空",
      "triggers.wecom 已启用，但 Token 或 EncodingAESKey 未设置",
    ]);

    const partial = createTriggerAdapters(cfg, { GH_SECRET_ENV: GITHUB_SECRET });
    expect(partial.adapters.map((a) => a.name)).toEqual(["github-actions"]);
  });

  test("仓库白名单从配置流到适配器", async () => {
    const cfg = baseConfig();
    cfg.triggers = {
      enabled: true,
      port: 8798,
      githubActions: {
        enabled: true,
        secretEnv: "GH_SECRET_ENV",
        chatId: "chat-1",
        userId: "u1",
        repos: ["acme/pisa"],
      },
    };
    const { adapters } = createTriggerAdapters(cfg, { GH_SECRET_ENV: GITHUB_SECRET });
    const received: IncomingMessage[] = [];
    const body = JSON.stringify({
      action: "completed",
      repository: { full_name: "other/repo" },
      workflow_run: { id: 1, name: "CI", run_attempt: 1, conclusion: "failure" },
    });
    const res = await handlerFor(adapters, received)(
      new Request("http://127.0.0.1/triggers/github-actions", {
        method: "POST",
        headers: { "x-github-event": "workflow_run", "x-hub-signature-256": signGithub(body) },
        body,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "仓库 other/repo 不在白名单" });
    expect(received).toHaveLength(0);
  });
});
