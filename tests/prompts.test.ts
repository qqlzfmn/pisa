import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildPrompt } from "../src/adapters/omp";
import type { Config } from "../src/config";
import { GitDeliverer } from "../src/deliver";
import { defaultPrompts, loadPrompts } from "../src/prompts";
import { Router } from "../src/router";
import { Store } from "../src/store";
import type { ChannelAdapter, IncomingMessage, Task } from "../src/types";
import type { WorkerRunner } from "../src/worker";

const roots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pisa-prompts-"));
  roots.push(dir);
  return dir;
}

function writeAt(root: string, rel: string, body: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "t_1",
    source: "test",
    channel: "cli",
    chatId: "c1",
    requester: "u1",
    repo: "demo",
    prompt: "修一下登录",
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
    createdAt: 0,
    startedAt: null,
    endedAt: null,
    cancelRequested: false,
    ...over,
  };
}

function positions(text: string, needles: string[]): number[] {
  return needles.map((needle) => text.indexOf(needle));
}

function manifest(sections: Record<string, number>): string {
  return JSON.stringify({ version: 1, sections });
}

function builtinFixture(files: Record<string, string>): string {
  const root = tmpRoot();
  for (const [rel, body] of Object.entries(files)) writeAt(root, rel, body);
  return root;
}

function overrideFile(version: number, body: string): string {
  return `---\nversion: ${version}\n---\n\n${body}\n`;
}

describe("提示词库", () => {
  test("内置清单加载全部段落，带版本号与来源", () => {
    const lib = defaultPrompts();
    expect(lib.version).toBe(1);
    expect(lib.keys()).toEqual([
      "worker.title",
      "worker.resume",
      "worker.context",
      "worker.task",
      "worker.constraints",
      "worker.review",
      "proactive.keywords",
      "proactive.probe",
    ]);
    const title = lib.resolve("worker.title");
    expect(title.source).toBe("builtin");
    expect(title.version).toBe(1);
    expect(title.text).toBe("你是 pisa 的 Worker，任务号 {{taskId}}。");
  });

  test("Worker 提示词按固定顺序拼装，条件段落只在需要时出现", () => {
    const plain = buildPrompt(makeTask());
    const plainAt = positions(plain, ["你是 pisa 的 Worker", "## 任务", "## 约束", "## 完成标准"]);
    expect(plainAt[0]!).toBeLessThan(plainAt[1]!);
    expect(plainAt[1]!).toBeLessThan(plainAt[2]!);
    expect(plainAt[2]!).toBeLessThan(plainAt[3]!);
    expect(plain).not.toContain("## 恢复执行");
    expect(plain).not.toContain("## 上一轮上下文");
    expect(plain).toContain("修一下登录");

    const full = buildPrompt(makeTask({ context: "上一轮改了登录接口" }), { resume: true });
    const order = positions(full, [
      "你是 pisa 的 Worker",
      "## 恢复执行",
      "## 上一轮上下文",
      "## 任务",
      "## 约束",
      "## 完成标准",
    ]);
    for (let i = 1; i < order.length; i += 1) expect(order[i]!).toBeGreaterThan(order[i - 1]!);
    expect(full).toContain("上一轮改了登录接口");
  });

  test("团队覆盖生效，按任务拼装时替换内置段落", () => {
    const root = tmpRoot();
    writeAt(root, "worker.review.md", overrideFile(7, "## 完成标准\n- 团队评审：必须附截图"));
    const lib = loadPrompts({ dir: root, repos: ["demo"] });
    const review = lib.resolve("worker.review");
    expect(review.source).toBe("team");
    expect(review.version).toBe(7);
    expect(review.builtinVersion).toBe(1);
    const prompt = buildPrompt(makeTask(), { prompts: lib });
    expect(prompt).toContain("团队评审：必须附截图");
    expect(prompt).not.toContain("有测试就跑测试");
  });

  test("仓库覆盖优先于团队，未命中的仓库回退团队", () => {
    const root = tmpRoot();
    writeAt(root, "worker.review.md", overrideFile(2, "团队评审"));
    writeAt(root, "repos/demo/worker.review.md", overrideFile(3, "仓库评审"));
    const lib = loadPrompts({ dir: root, repos: ["demo", "other"] });
    const repo = lib.resolve("worker.review", "demo");
    expect(repo.source).toBe("repo");
    expect(repo.version).toBe(3);
    expect(repo.text).toBe("仓库评审");
    expect(lib.resolve("worker.review", "other").source).toBe("team");
    expect(lib.resolve("worker.review").source).toBe("team");
    expect(buildPrompt(makeTask(), { prompts: lib })).toContain("仓库评审");
    expect(buildPrompt(makeTask({ repo: "other" }), { prompts: lib })).toContain("团队评审");
  });

  test("覆盖目录不存在或缺省时回退内置", () => {
    const missing = join(tmpRoot(), "nope");
    expect(loadPrompts({ dir: missing }).resolve("worker.review").source).toBe("builtin");
    expect(loadPrompts().resolve("worker.review").source).toBe("builtin");
  });

  test("未知键、坏版本、坏占位符、未知仓库别名都拒绝加载", () => {
    const unknown = tmpRoot();
    writeAt(unknown, "worker.nope.md", overrideFile(1, "x"));
    expect(() => loadPrompts({ dir: unknown })).toThrow(/未知提示词段落/);

    const badHeader = tmpRoot();
    writeAt(badHeader, "worker.review.md", "没有头部的正文");
    expect(() => loadPrompts({ dir: badHeader })).toThrow(/缺少头部/);

    const badVersion = tmpRoot();
    writeAt(badVersion, "worker.review.md", overrideFile(0, "正文"));
    expect(() => loadPrompts({ dir: badVersion })).toThrow(/version 必须是正整数/);

    const extraHeader = tmpRoot();
    writeAt(extraHeader, "worker.review.md", "---\nversion: 1\nauthor: me\n---\n正文");
    expect(() => loadPrompts({ dir: extraHeader })).toThrow(/未知键 author/);

    const badVariable = tmpRoot();
    writeAt(badVariable, "worker.review.md", overrideFile(1, "{{taskID}}"));
    expect(() => loadPrompts({ dir: badVariable })).toThrow(/未知占位符 \{\{taskID\}\}/);

    const unknownRepo = tmpRoot();
    writeAt(unknownRepo, "repos/ghost/worker.review.md", overrideFile(1, "正文"));
    expect(() => loadPrompts({ dir: unknownRepo, repos: ["demo"] })).toThrow(/不在配置 repos/);
    expect(() => loadPrompts({ dir: unknownRepo })).toThrow(/不在配置 repos/);
  });

  test("内置清单拒绝坏清单、缺文件与未登记文件", () => {
    const missing = builtinFixture({ "manifest.json": manifest({ "worker.title": 1 }) });
    expect(() => loadPrompts({ builtinDir: missing })).toThrow(/缺少文件/);

    const extra = builtinFixture({
      "manifest.json": manifest({ "worker.title": 1 }),
      "worker/title.md": "标题",
      "worker/extra.md": "多出来的段落",
    });
    expect(() => loadPrompts({ builtinDir: extra })).toThrow(/未在清单登记/);

    const badJson = builtinFixture({ "manifest.json": "{not json" });
    expect(() => loadPrompts({ builtinDir: badJson })).toThrow(/不是合法 JSON/);

    const badSectionVersion = builtinFixture({
      "manifest.json": manifest({ "worker.title": 0 }),
      "worker/title.md": "标题",
    });
    expect(() => loadPrompts({ builtinDir: badSectionVersion })).toThrow(/version 必须是正整数/);
  });

  test("覆盖列表显示来源与版本，diff 给出 unified diff", () => {
    const root = tmpRoot();
    writeAt(root, "worker.review.md", overrideFile(2, "## 完成标准\n- 有测试就跑测试\n- 团队追加：附截图"));
    const lib = loadPrompts({ dir: root, repos: ["demo"] });
    const listing = lib.describe();
    expect(listing).toContain("提示词 v1");
    expect(listing).toContain("worker.review · 团队 v2");
    expect(listing).toContain("worker.title · 内置 v1");

    const diff = lib.diff(undefined, "worker.review");
    expect(diff).toContain("--- 内置 v1");
    expect(diff).toContain("+++ 生效 v2");
    expect(diff).toContain("@@");
    expect(diff).toContain("+- 团队追加：附截图");
    expect(lib.diff(undefined, "worker.title")).toContain("没有覆盖");
    expect(() => lib.diff(undefined, "worker.nope")).toThrow(/未知提示词段落/);
  });

  test("覆盖正文与内置一致时 diff 明确说明", () => {
    const root = tmpRoot();
    const base = defaultPrompts().resolve("worker.review");
    writeAt(root, "worker.review.md", overrideFile(2, base.text));
    expect(loadPrompts({ dir: root }).diff(undefined, "worker.review")).toContain("内容与内置一致");
  });
});

class FakeChannel implements ChannelAdapter {
  name = "fake";
  sent: Array<{ chatId: string; text: string }> = [];
  async start(): Promise<void> {}
  async send(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
  async stop(): Promise<void> {}
}

function makeCfg(): Config {
  return {
    trigger: "/pisa",
    dmWithoutTrigger: true,
    whitelist: { users: ["u1"], repos: ["demo"] },
    repos: [{ alias: "demo", path: "/tmp/pisa-demo", baseBranch: "main" }],
    worker: { adapter: "omp", command: "noop", timeoutSec: 5, extraArgs: [], concurrency: 1 },
    delivery: { push: false, pr: false, commitName: "pisa", commitEmail: "pisa@localhost" },
    channels: { cli: true },
    stateDir: "/tmp/pisa-prompts-state",
  };
}

function makeMsg(text: string): IncomingMessage {
  return {
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    channel: "fake",
    chatId: "c1",
    userId: "u1",
    text,
    isDirect: true,
  };
}

describe("Router 提示词命令", () => {
  test("/pisa prompts 与 diff 输出，未知键给出错误而不是抛异常", async () => {
    const root = tmpRoot();
    writeAt(root, "worker.review.md", overrideFile(2, "团队版本"));
    writeAt(root, "repos/demo/worker.review.md", overrideFile(4, "## 完成标准\n- 仓库追加：先跑全量测试"));
    const lib = loadPrompts({ dir: root, repos: ["demo"] });
    const channel = new FakeChannel();
    const store = new Store(":memory:");
    const worker: WorkerRunner = {
      async run() {
        return { ok: true, summary: "", exitCode: 0 };
      },
    };
    const cfg = makeCfg();
    const router = new Router({
      cfg,
      store,
      worker,
      deliverer: new GitDeliverer(cfg),
      channel,
      prompts: lib,
    });
    try {
      await router.handle(makeMsg("/pisa @demo prompts"));
      expect(channel.sent.at(-1)?.text).toContain("worker.review · 仓库 demo v4");

      await router.handle(makeMsg("/pisa @demo prompts diff worker.review"));
      expect(channel.sent.at(-1)?.text).toContain("+++ 生效 v4");
      expect(channel.sent.at(-1)?.text).toContain("仓库追加：先跑全量测试");

      await router.handle(makeMsg("/pisa prompts diff worker.nope"));
      expect(channel.sent.at(-1)?.text).toContain("未知提示词段落");

      await router.handle(makeMsg("/pisa prompts bogus"));
      expect(channel.sent.at(-1)?.text).toContain("用法：");
    } finally {
      store.close();
    }
  });
});
