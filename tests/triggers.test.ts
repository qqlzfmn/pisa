import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, FeishuTriggerConfig, FileTriggerConfig, GithubActionsTriggerConfig } from "../src/config";
import { Store } from "../src/store";
import { Router } from "../src/router";
import { GitDeliverer } from "../src/deliver";
import { sh } from "../src/git";
import type { ChannelAdapter, IncomingMessage, WorkerResult } from "../src/types";
import type { WorkerRunner } from "../src/worker";
import { FeishuTrigger } from "../src/triggers/feishu";
import { FileTrigger } from "../src/triggers/files";
import { GithubActionsTrigger } from "../src/triggers/github-actions";
import { TriggerHub } from "../src/triggers/hub";
import { buildTriggers } from "../src/triggers";
import type { TriggerRequest } from "../src/triggers/types";
import { hmacSha256Hex, sha256Hex } from "../src/triggers/verify";

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: Array<{ chatId: string; text: string }> = [];
  async start(): Promise<void> {}
  private seq = 0;
  async send(chatId: string, text: string): Promise<{ messageId: string }> {
    this.sent.push({ chatId, text });
    this.seq += 1;
    return { messageId: String(this.seq) };
  }
  async stop(): Promise<void> {}
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-repo-"));
  sh(["git", "init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, "README.md"), "hello\n");
  sh(["git", "-C", dir, "add", "-A"]);
  sh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return dir;
}

function baseCfg(repoPath: string, over: Partial<Config> = {}): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: repoPath, baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir: join(tmpdir(), "pisa-triggers-state"),
    ...over,
  };
}

/** 解析 Hub 的 200 回执，取已投递的去重键 */
function acceptedKeys(body: string): string[] {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || !("accepted" in parsed)) {
    throw new Error(`回执不是对象：${body}`);
  }
  const { accepted } = parsed;
  if (!Array.isArray(accepted)) throw new Error(`回执缺少 accepted：${body}`);
  return accepted.map((key) => String(key));
}

/** 投递收集器：只记录，等待交给 untilWrite 的轮询 */
class Collector {
  readonly got: IncomingMessage[] = [];
  readonly deliver = (m: IncomingMessage): void => void this.got.push(m);
}

/**
 * `fs.watch` 的事件可能在监听注册完成前丢失（见 spec §4：漏一次会在下一次写入重新触发），
 * 所以重写同一内容直到命中目标消息。这里必须用真实时间轮询：`fs.watch` 的事件与去抖都由
 * 平台时钟驱动，fake timer 推进不了操作系统的投递。
 */
async function untilWrite(
  collector: Collector,
  file: string,
  content: string,
  match: (m: IncomingMessage) => boolean,
): Promise<IncomingMessage> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const hit = collector.got.find(match);
    if (hit) return hit;
    writeFileSync(file, content);
    await Bun.sleep(50);
  }
  throw new Error(`等待 ${file} 的事件超时：监听可能未注册或事件未投递`);
}

// ---------- GitHub Actions ----------

const GH_SECRET = "gh-secret";

const ghCfg: GithubActionsTriggerConfig = {
  enabled: true,
  chatId: "c1",
  userId: "u1",
  repo: "demo",
  secretEnv: "PISA_TEST_GH_SECRET",
};

function runPayload(
  over: Partial<{ repo: string; conclusion: string; branch: string; action: string; runId: number; attempt: number; name: string }> = {},
): string {
  const o = { repo: "owner/pisa", conclusion: "failure", branch: "main", action: "completed", runId: 42, attempt: 1, name: "CI", ...over };
  return JSON.stringify({
    action: o.action,
    repository: { full_name: o.repo },
    workflow_run: {
      id: o.runId,
      run_attempt: o.attempt,
      name: o.name,
      head_branch: o.branch,
      conclusion: o.conclusion,
      html_url: `https://github.com/${o.repo}/actions/runs/${o.runId}`,
      head_sha: "abcdef1234567890",
    },
  });
}

function ghRequest(body: string, opts: { event?: string; secret?: string } = {}): TriggerRequest {
  return {
    headers: {
      "x-github-event": opts.event ?? "workflow_run",
      "x-hub-signature-256": `sha256=${hmacSha256Hex(opts.secret ?? GH_SECRET, body)}`,
    },
    body,
  };
}

function githubAdapter(over: Partial<GithubActionsTriggerConfig> = {}): GithubActionsTrigger {
  return new GithubActionsTrigger({ ...ghCfg, ...over }, "/pisa", GH_SECRET);
}

describe("GitHub Actions 适配器", () => {
  test("签名正确时归一化出带运行链接的事件", () => {
    const body = runPayload();
    const res = githubAdapter().normalize(ghRequest(body));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events).toHaveLength(1);
    const [event] = res.events;
    expect(event!.dedupeKey).toBe("github-actions:owner/pisa:42:1");
    expect(event!.message.channel).toBe("github-actions");
    expect(event!.message.chatId).toBe("c1");
    expect(event!.message.userId).toBe("u1");
    expect(event!.message.repo).toBe("demo");
    expect(event!.message.eventId).toBe(event!.dedupeKey);
    expect(event!.message.text).toContain("/pisa ");
    expect(event!.message.text).toContain("owner/pisa");
    expect(event!.message.text).toContain("CI");
    expect(event!.message.text).toContain("分支: main");
    expect(event!.message.text).toContain("https://github.com/owner/pisa/actions/runs/42");
  });

  test("签名错误或缺失时拒绝", () => {
    const body = runPayload();
    const adapter = githubAdapter();
    expect(adapter.verify(ghRequest(body, { secret: "wrong" }))).toEqual({
      ok: false,
      status: 403,
      error: "signature mismatch",
    });
    expect(adapter.verify({ headers: {}, body }).ok).toBe(false);
    expect(adapter.verify({ headers: { "x-hub-signature-256": "md5=abc" }, body }).ok).toBe(false);
  });

  test("同一运行重复投递得到相同去重键", () => {
    const adapter = githubAdapter();
    const body = runPayload();
    const first = adapter.normalize(ghRequest(body));
    const second = adapter.normalize(ghRequest(body));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.events[0]!.dedupeKey).toBe(second.events[0]!.dedupeKey);
  });

  test("重跑是新的 attempt，去重键不同", () => {
    const adapter = githubAdapter();
    const first = adapter.normalize(ghRequest(runPayload({ attempt: 1 })));
    const second = adapter.normalize(ghRequest(runPayload({ attempt: 2 })));
    if (!first.ok || !second.ok) throw new Error("归一化失败");
    expect(first.events[0]!.dedupeKey).not.toBe(second.events[0]!.dedupeKey);
  });

  test("非法载荷返回 400", () => {
    const adapter = githubAdapter();
    expect(adapter.normalize(ghRequest("{not json"))).toEqual({ ok: false, status: 400, error: "invalid json" });
    const noRun = JSON.stringify({ action: "completed", repository: { full_name: "owner/pisa" } });
    expect(adapter.normalize(ghRequest(noRun))).toEqual({ ok: false, status: 400, error: "missing workflow_run" });
    const noRepo = JSON.stringify({ action: "completed", workflow_run: { id: 7 } });
    expect(adapter.normalize(ghRequest(noRepo))).toEqual({ ok: false, status: 400, error: "missing workflow_run" });
  });

  test("无关事件返回 200 且不产生任务", () => {
    const adapter = githubAdapter();
    expect(adapter.normalize(ghRequest(JSON.stringify({ zen: "hi" }), { event: "ping" }))).toEqual({ ok: true, events: [] });
    expect(adapter.normalize(ghRequest(runPayload({ action: "in_progress" })))).toEqual({ ok: true, events: [] });
    expect(adapter.normalize(ghRequest(runPayload({ conclusion: "success" })))).toEqual({ ok: true, events: [] });
    expect(adapter.normalize(ghRequest(runPayload({ conclusion: "cancelled" })))).toEqual({ ok: true, events: [] });
  });

  test("仓库与分支白名单", () => {
    const adapter = githubAdapter({ repos: ["owner/pisa"], branches: ["main"] });
    expect(adapter.normalize(ghRequest(runPayload({ repo: "other/pisa" })))).toEqual({ ok: true, events: [] });
    expect(adapter.normalize(ghRequest(runPayload({ branch: "release" })))).toEqual({ ok: true, events: [] });
    // 仓库全名大小写不敏感（GitHub 自己的约定）
    const hit = adapter.normalize(ghRequest(runPayload({ repo: "Owner/Pisa" })));
    expect(hit.ok && hit.events.length).toBe(1);
  });
});

// ---------- 飞书 ----------

const FEISHU_ENC = "feishu-enc";
const FEISHU_TOKEN = "feishu-vt";

const feishuCfg: FeishuTriggerConfig = {
  enabled: true,
  chatId: "c1",
  userId: "u1",
  repo: "demo",
  encryptKeyEnv: "PISA_TEST_FEISHU_ENC",
  verificationTokenEnv: "PISA_TEST_FEISHU_TOKEN",
};

interface FeishuOver {
  eventId?: string | null;
  messageId?: string | null;
  eventType?: string;
  messageType?: string;
  chatType?: string;
  content?: string;
  text?: string;
  openId?: string | null;
  senderType?: string;
  mentions?: Array<{ key: string }>;
  token?: string;
}

function feishuBody(over: FeishuOver = {}): string {
  const o = {
    eventId: "ev_1",
    messageId: "om_1",
    eventType: "im.message.receive_v1",
    messageType: "text",
    chatType: "p2p",
    text: "修一下登录超时",
    openId: "ou_1",
    senderType: "user",
    mentions: [] as Array<{ key: string }>,
    token: FEISHU_TOKEN,
    ...over,
  };
  const header: Record<string, unknown> = { event_type: o.eventType, token: o.token };
  if (o.eventId !== null) header.event_id = o.eventId;
  const message: Record<string, unknown> = {
    chat_type: o.chatType,
    message_type: o.messageType,
    content: o.content ?? JSON.stringify({ text: o.text }),
    mentions: o.mentions,
  };
  if (o.messageId !== null) message.message_id = o.messageId;
  const sender: Record<string, unknown> = { sender_type: o.senderType, sender_id: {} };
  if (o.openId !== null) (sender.sender_id as Record<string, unknown>).open_id = o.openId;
  return JSON.stringify({ schema: "2.0", header, event: { sender, message } });
}

function feishuRequest(body: string, opts: { key?: string; at?: number } = {}): TriggerRequest {
  const timestamp = String(opts.at ?? Math.floor(Date.now() / 1000));
  const nonce = "nonce-1";
  return {
    headers: {
      "x-lark-request-timestamp": timestamp,
      "x-lark-request-nonce": nonce,
      "x-lark-signature": sha256Hex(`${timestamp}${nonce}${opts.key ?? FEISHU_ENC}${body}`),
    },
    body,
  };
}

function feishuAdapter(over: Partial<FeishuTriggerConfig> = {}): FeishuTrigger {
  return new FeishuTrigger({ ...feishuCfg, ...over }, "/pisa", FEISHU_ENC, FEISHU_TOKEN);
}

describe("飞书适配器", () => {
  test("URL 校验握手在验签之前应答", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123", token: FEISHU_TOKEN });
    const reply = await new TriggerHub({ port: 0, adapters: [feishuAdapter()], sources: [], deliver: () => {} }).receive(
      "feishu",
      { headers: {}, body },
    );
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ challenge: "abc123" });
  });

  test("握手时验证 token 不符返回 403", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc", token: "wrong" });
    const reply = await new TriggerHub({ port: 0, adapters: [feishuAdapter()], sources: [], deliver: () => {} }).receive(
      "feishu",
      { headers: {}, body },
    );
    expect(reply.status).toBe(403);
  });

  test("私聊文本消息归一化为任务", () => {
    const res = feishuAdapter().normalize(feishuRequest(feishuBody()));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events).toHaveLength(1);
    const [event] = res.events;
    expect(event!.dedupeKey).toBe("feishu:ev_1");
    expect(event!.message.channel).toBe("feishu");
    expect(event!.message.text).toBe("修一下登录超时");
    expect(event!.message.isDirect).toBe(true);
    expect(event!.message.chatId).toBe("c1");
  });

  test("签名错误、时间戳过期、发送者不在白名单都返回 403", () => {
    const body = feishuBody();
    const adapter = feishuAdapter();
    expect(adapter.verify(feishuRequest(body, { key: "other" }))).toEqual({
      ok: false,
      status: 403,
      error: "signature mismatch",
    });
    const stale = Math.floor(Date.now() / 1000) - 1000;
    expect(adapter.verify(feishuRequest(body, { at: stale }))).toEqual({
      ok: false,
      status: 403,
      error: "stale or missing timestamp",
    });
    expect(adapter.verify({ headers: {}, body }).ok).toBe(false);

    const restricted = feishuAdapter({ users: ["ou_allowed"] });
    expect(restricted.normalize(feishuRequest(body))).toEqual({
      ok: false,
      status: 403,
      error: "sender not allowed",
    });
    expect(restricted.normalize(feishuRequest(feishuBody({ openId: "ou_allowed" }))).ok).toBe(true);
  });

  test("同一 event_id 重复投递得到相同去重键", () => {
    const adapter = feishuAdapter();
    const first = adapter.normalize(feishuRequest(feishuBody()));
    const second = adapter.normalize(feishuRequest(feishuBody()));
    if (!first.ok || !second.ok) throw new Error("归一化失败");
    expect(first.events[0]!.dedupeKey).toBe(second.events[0]!.dedupeKey);
  });

  test("非法载荷返回 400", () => {
    const adapter = feishuAdapter();
    expect(adapter.normalize(feishuRequest("{not json"))).toEqual({ ok: false, status: 400, error: "invalid json" });
    expect(adapter.normalize(feishuRequest(feishuBody({ messageId: null })))).toEqual({
      ok: false,
      status: 400,
      error: "missing message_id",
    });
    expect(adapter.normalize(feishuRequest(feishuBody({ openId: null })))).toEqual({
      ok: false,
      status: 400,
      error: "missing sender open_id",
    });
    expect(adapter.normalize(feishuRequest(feishuBody({ content: "{not json" })))).toEqual({
      ok: false,
      status: 400,
      error: "invalid message content",
    });
  });

  test("无关事件与非文本消息不产生任务", () => {
    const adapter = feishuAdapter();
    expect(adapter.normalize(feishuRequest(feishuBody({ eventType: "im.chat.member.bot.added_v1" })))).toEqual({
      ok: true,
      events: [],
    });
    expect(adapter.normalize(feishuRequest(feishuBody({ messageType: "image" })))).toEqual({ ok: true, events: [] });
    expect(adapter.normalize(feishuRequest(feishuBody({ text: "   " })))).toEqual({ ok: true, events: [] });
    expect(adapter.normalize(feishuRequest(feishuBody({ senderType: "app" })))).toEqual({ ok: true, events: [] });
  });

  test("群消息 @ 机器人时补触发词，不提及时保持原样", () => {
    const adapter = feishuAdapter();
    const mentioned = adapter.normalize(
      feishuRequest(
        feishuBody({ chatType: "group", text: "@_user_1 部署脚本挂了", mentions: [{ key: "@_user_1" }] }),
      ),
    );
    if (!mentioned.ok) throw new Error("归一化失败");
    expect(mentioned.events[0]!.message.isDirect).toBe(false);
    expect(mentioned.events[0]!.message.text).toBe("/pisa 部署脚本挂了");

    const plain = adapter.normalize(feishuRequest(feishuBody({ chatType: "group", text: "今天吃什么" })));
    if (!plain.ok) throw new Error("归一化失败");
    expect(plain.events[0]!.message.text).toBe("今天吃什么");
  });
});

// ---------- 文件监听 ----------

describe("文件监听", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pisa-files-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function startSource(over: Partial<FileTriggerConfig> = {}) {
    const collector = new Collector();
    const cfg: FileTriggerConfig = {
      enabled: true,
      chatId: "c1",
      userId: "u1",
      repo: "demo",
      paths: [dir],
      debounceMs: 20,
      ...over,
    };
    const source = new FileTrigger(cfg, { trigger: "/pisa", deliver: collector.deliver });
    source.start();
    return { collector, source };
  }

  test("目录内写入文件后投递事件", async () => {
    const { collector, source } = startSource();
    try {
      const file = join(dir, "a.txt");
      const message = await untilWrite(collector, file, "alpha\n", (m) => m.text.includes(file));
      expect(message.channel).toBe("files");
      expect(message.text).toContain("/pisa ");
      expect(message.eventId.startsWith("files:")).toBe(true);
    } finally {
      source.stop();
    }
  });

  test("同一内容重写去重键不变，内容变化后键改变", async () => {
    const { collector, source } = startSource();
    try {
      const file = join(dir, "a.txt");
      const first = await untilWrite(collector, file, "alpha\n", () => true);
      const repeat = await untilWrite(collector, file, "alpha\n", (m) => m !== first);
      expect(repeat.eventId).toBe(first.eventId);

      const changed = await untilWrite(collector, file, "beta\n", (m) => m.eventId !== first.eventId);
      expect(changed.eventId).not.toBe(first.eventId);
    } finally {
      source.stop();
    }
  });

  test("监听路径不存在时只告警，不阻断启动", () => {
    const { source } = startSource({ paths: [join(dir, "missing")] });
    expect(() => source.stop()).not.toThrow();
  });

  test("单文件监听只响应目标文件", async () => {
    const target = join(dir, "target.txt");
    writeFileSync(target, "one\n");
    const { collector, source } = startSource({ paths: [target] });
    try {
      // 同目录的非目标文件不进消息
      writeFileSync(join(dir, "other.txt"), "noise\n");
      const message = await untilWrite(collector, target, "two\n", (m) => m.text.includes(target));
      expect(message.text).not.toContain("other.txt");
    } finally {
      source.stop();
    }
  });
});

// ---------- 适配器 → Router：去重与白名单 ----------

describe("适配器经 Hub 投递到 Router", () => {
  let repo: string;
  let store: Store;
  let channel: FakeChannel;
  let cfg: Config;

  const noopWorker: WorkerRunner = {
    async run(): Promise<WorkerResult> {
      return { ok: true, summary: "noop", exitCode: 0 };
    },
  };

  beforeEach(() => {
    repo = makeRepo();
    store = new Store(":memory:");
    channel = new FakeChannel();
    cfg = baseCfg(repo);
  });

  afterEach(() => {
    store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  function hub(adapters: Array<GithubActionsTrigger | FeishuTrigger>): TriggerHub {
    const router = new Router({
      cfg,
      store,
      worker: noopWorker,
      deliverer: new GitDeliverer(cfg),
      channel,
    });
    return new TriggerHub({ port: 0, adapters, sources: [], deliver: (m) => router.handle(m) });
  }

  test("同一 workflow_run 重复投递只建一个任务", async () => {
    const body = runPayload();
    const h = hub([githubAdapter()]);
    const first = await h.receive("github-actions", ghRequest(body));
    const second = await h.receive("github-actions", ghRequest(body));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(store.recentTasks()).toHaveLength(1);
    expect(channel.sent.filter((s) => s.text.includes("已接单"))).toHaveLength(1);
  });

  test("签名失败不产生任务", async () => {
    const h = hub([githubAdapter()]);
    const reply = await h.receive("github-actions", ghRequest(runPayload(), { secret: "wrong" }));
    expect(reply.status).toBe(403);
    expect(store.recentTasks()).toHaveLength(0);
  });

  test("同一飞书 event_id 重复投递只建一个任务", async () => {
    const body = feishuBody();
    const h = hub([feishuAdapter()]);
    await h.receive("feishu", feishuRequest(body));
    await h.receive("feishu", feishuRequest(body));
    expect(store.recentTasks()).toHaveLength(1);
    expect(store.recentTasks()[0]!.prompt).toBe("修一下登录超时");
  });

  test("未挂载路径返回 404", async () => {
    const reply = await hub([githubAdapter()]).receive("nope", ghRequest(runPayload()));
    expect(reply.status).toBe(404);
  });

  test("白名单不匹配时不建任务", async () => {
    cfg = baseCfg(repo, { whitelist: { users: ["someone-else"], repos: ["demo"] } });
    const h = hub([githubAdapter()]);
    await h.receive("github-actions", ghRequest(runPayload()));
    expect(store.recentTasks()).toHaveLength(0);
  });
});

// ---------- 装配与 HTTP 层 ----------

describe("buildTriggers", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    delete process.env.PISA_TEST_GH_SECRET;
    delete process.env.PISA_TEST_FEISHU_ENC;
    delete process.env.PISA_TEST_FEISHU_TOKEN;
  });

  test("未启用时不启动任何入口", () => {
    expect(buildTriggers({ cfg: baseCfg(repo), deliver: () => {} })).toBeNull();
    expect(buildTriggers({ cfg: baseCfg(repo, { triggers: { enabled: false } }), deliver: () => {} })).toBeNull();
  });

  test("启用但所有来源关闭时返回 null", () => {
    const cfg = baseCfg(repo, { triggers: { enabled: true, githubActions: { ...ghCfg, enabled: false } } });
    expect(buildTriggers({ cfg, deliver: () => {} })).toBeNull();
  });

  test("缺凭据时跳过该来源", () => {
    const gh = baseCfg(repo, { triggers: { enabled: true, githubActions: ghCfg } });
    expect(buildTriggers({ cfg: gh, deliver: () => {} })).toBeNull();

    // 配了验证令牌却读不到环境变量：来源整个跳过，URL 校验不能被无条件放行
    process.env.PISA_TEST_FEISHU_ENC = FEISHU_ENC;
    const feishu = baseCfg(repo, { triggers: { enabled: true, feishu: feishuCfg } });
    expect(buildTriggers({ cfg: feishu, deliver: () => {} })).toBeNull();
  });

  test("凭据齐全时挂载适配器", async () => {
    process.env.PISA_TEST_GH_SECRET = GH_SECRET;
    process.env.PISA_TEST_FEISHU_ENC = FEISHU_ENC;
    process.env.PISA_TEST_FEISHU_TOKEN = FEISHU_TOKEN;
    const cfg = baseCfg(repo, {
      triggers: { enabled: true, githubActions: ghCfg, feishu: feishuCfg },
    });
    const hub = buildTriggers({ cfg, deliver: () => {} });
    expect(hub).not.toBeNull();
    const unsigned = await hub!.receive("github-actions", { headers: { "x-github-event": "workflow_run" }, body: "{}" });
    expect(unsigned.status).toBe(403);
    const signed = await hub!.receive("github-actions", ghRequest(runPayload()));
    expect(signed.status).toBe(200);
    const handshake = await hub!.receive("feishu", {
      headers: {},
      body: JSON.stringify({ type: "url_verification", challenge: "c", token: "wrong" }),
    });
    expect(handshake.status).toBe(403);
  });

  test("HTTP 层：方法、路径与体积限制", async () => {
    const hub = new TriggerHub({ port: 0, adapters: [githubAdapter()], sources: [], deliver: () => {} });
    hub.start();
    const base = `http://127.0.0.1:${hub.port}/triggers/github-actions`;
    try {
      expect((await fetch(base)).status).toBe(405);
      expect((await fetch(`http://127.0.0.1:${hub.port}/other`, { method: "POST", body: "{}" })).status).toBe(404);
      const big = await fetch(base, { method: "POST", body: "x".repeat(300 * 1024) });
      expect(big.status).toBe(413);
      const body = runPayload();
      const ok = await fetch(base, { method: "POST", headers: ghRequest(body).headers, body });
      expect(ok.status).toBe(200);
      expect(acceptedKeys(await ok.text())).toEqual(["github-actions:owner/pisa:42:1"]);
    } finally {
      hub.stop();
    }
  });
});
