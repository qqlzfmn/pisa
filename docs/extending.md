# 扩展指南

这份文档只讲怎么接新东西：从哪个文件开始、接口长什么样、在哪里接线、测试怎么写。分层理由见 [architecture.md](./architecture.md#4-扩展点)，术语见 [domain.md](./domain.md)，部署与排障见 [deployment.md](./deployment.md)。

所有示例都按「先定身份，再写实现，再接线，再写测试」组织。身份定错，后面的去重、续跑、回执都会错。

## 1. 先判断要加什么

| 需求 | 加什么 | 入口 | 本文档 |
| --- | --- | --- | --- |
| 外部系统主动 POST 事件（webhook、CI、告警） | `TriggerAdapter` + 一条 HTTP 路由 | `src/triggers/http.ts` | [加协议型 Source](#3-加协议型-sourcetriggeradapter) |
| 需要定时拉取、监听文件或长连接的自有协议 | 常驻 Source：自己持 timer 或 watcher | `src/index.ts` 装配 | [加常驻型 Source](#4-加常驻型-source) |
| 新的 IM 能收也能回 | `ChannelAdapter` | `src/channels/` | [architecture.md §4.3](./architecture.md#43-入口客户端加通道) |
| 换执行任务的 agent CLI | `WorkerAdapter` | `src/adapters/` | [加 WorkerAdapter](#5-加-workeradapter) |

`Source` 是统称，仓库里没有同名类型。两种形态的共同点是产出一条 `IncomingMessage` 并交给 `Router.handle`，区别只在谁来触发。

## 2. 两种形态

**协议型**实现 [`TriggerAdapter`](../src/triggers/types.ts)，由 `startTriggers` 挂在 `127.0.0.1` 的共享 HTTP 端口上。适配器只做三段：验签与解析、归一化、去重键。

**常驻型**是一个普通类，构造参数收 `cfg`、`store`、`enqueue`，自己实现 `start()` / `stop()`。需要增量游标时写 `meta` 表，不要把任务写进自己的表；任务落库只由 Router 负责。

两种形态都要遵守：

- 只通过注入的 `handle` 或 `enqueue` 调用 Router，不直接 import `Router` 实例。
- 不自己写 `tasks` 表；`store` 只用于游标、开关等元数据。
- 来源级白名单在适配器里先过滤一次，Router 还会按 `whitelist.users` / `whitelist.repos` 再校验一次。
- 可重放：同一事件重复到达不能重复建单。协议型靠 `dedupeKey`，常驻型靠落库游标加 `eventId`。
- 失败要区分「这条不要」与「这次没拉到」：前者返回 `null` 或 2xx 忽略，后者抛错或保留游标，下一轮重试。

## 3. 加协议型 Source（TriggerAdapter）

以 `POST /acme/event` 为例，完整走一遍。

### 3.1 定身份

| 字段 | 本例取值 | 规则 |
| --- | --- | --- |
| `source` | `acme` | 触发身份里的来源名，稳定不变 |
| `threadKey` | `acme:<发送者>` | 同一条对话线；同线程的后继消息会并进未结束任务，拿不准就用事件自身的会话 id |
| `messageKey` | 事件 id | 来源内唯一；编辑不换键 |
| `version` | 事件版本或时间戳 | 同一条消息被修改时递增 |
| `actor` | 实际发送者 | 用于展示与审计，不用于鉴权 |
| `dedupeKey` | `acme:<事件 id>` | 同一事件重复投递必须相同 |

`payloadHash` 不用自己算，`Router` 会用正文归一化后的指纹补齐。

### 3.2 写适配器

新建 `src/triggers/acme.ts`：

```ts
import type { AcmeTriggerConfig } from "../config";
import { safeEqual } from "../http";
import {
  commandText,
  TriggerError,
  type HttpTriggerRequest,
  type TriggerAdapter,
  type TriggerOutcome,
} from "./types";

interface AcmePayload {
  id: string;
  text: string;
  actor: string;
}

interface AcmeOptions {
  config: AcmeTriggerConfig;
  token: string;
  trigger: string;
  chatId: string;
  userId: string;
  repo?: string;
  now?: () => number;
}

export class AcmeAdapter implements TriggerAdapter<HttpTriggerRequest, AcmePayload> {
  readonly name = "acme";
  private readonly now: () => number;

  constructor(private readonly opts: AcmeOptions) {
    this.now = opts.now ?? Date.now;
  }

  async verify(req: HttpTriggerRequest): Promise<AcmePayload> {
    if (req.method !== "POST") throw new TriggerError(405, "method not allowed");
    if (!this.opts.token) throw new TriggerError(503, "acme token 未配置");
    const token = req.headers.get("x-acme-token") ?? "";
    if (!safeEqual(token, this.opts.token)) throw new TriggerError(401, "token 校验失败");

    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      throw new TriggerError(400, "请求体不是合法 JSON");
    }
    const body = parsed as Partial<AcmePayload>;
    if (typeof body.id !== "string" || typeof body.text !== "string") {
      throw new TriggerError(400, "缺少 id 或 text");
    }
    return { id: body.id, text: body.text, actor: typeof body.actor === "string" ? body.actor : "acme" };
  }

  normalize(payload: AcmePayload): TriggerOutcome | null {
    const users = this.opts.config.users ?? [];
    if (users.length > 0 && !users.includes(payload.actor)) return null;
    const key = this.dedupeKey(payload);
    return {
      event: {
        dedupeKey: key,
        message: {
          eventId: key,
          channel: "acme",
          chatId: this.opts.chatId,
          userId: this.opts.userId,
          actor: payload.actor,
          repo: this.opts.repo,
          text: commandText(this.opts.trigger, payload.text),
          threadKey: `acme:${payload.actor}`,
          messageKey: payload.id,
          receivedAt: this.now(),
        },
      },
    };
  }

  dedupeKey(payload: AcmePayload): string {
    return `acme:${payload.id}`;
  }
}
```

三个要点：

- `verify` 只负责「能不能信、解析成什么」，不要在这里建任务。
- `normalize` 返回 `null` 表示这条事件合法但不需要处理，HTTP 仍回 200。
- 签名或 token 用常量时间比较（`safeEqual`），缺失密钥返回 503，不要退化成免签。

### 3.3 加配置

在 `src/config.ts` 增加字段，并在 `pisa.config.example.json` 放一份示例：

```ts
export interface AcmeTriggerConfig {
  enabled?: boolean;
  tokenEnv: string;
  users?: string[];
}

export interface TriggersConfig {
  // 现有字段保持不变
  acme?: AcmeTriggerConfig;
}
```

```json
{
  "triggers": {
    "chatId": "acme-room",
    "userId": "alice",
    "repo": "pisa",
    "acme": {
      "enabled": true,
      "tokenEnv": "ACME_WEBHOOK_TOKEN",
      "users": ["alice"]
    }
  }
}
```

密钥只从环境变量读：启动服务前把 `ACME_WEBHOOK_TOKEN` 设为一段随机长串，配置文件里只写变量名。`triggers.chatId` 与 `triggers.userId` 是任务归属，必须同时在 `whitelist.users` 里，否则 Router 会拒绝。

### 3.4 接线

在 `src/triggers/http.ts` 导入适配器，在 `makeTriggersHandler` 里注册路由：

```ts
if (cfg.acme?.enabled) {
  requireIdentity("acme");
  routes.set(
    "/acme/event",
    new AcmeAdapter({
      config: cfg.acme,
      token: env[cfg.acme.tokenEnv] ?? "",
      trigger: deps.cfg.trigger,
      chatId,
      userId,
      repo: cfg.repo,
      now,
    }),
  );
}
```

`requireIdentity` 会在启用但缺归属身份时直接抛错，服务启动失败，而不是运行时静默丢事件。

共享 HTTP 服务只在内置入口启用或被 `triggers.http.enabled` 显式打开时启动。`src/triggers/index.ts` 的推导要加上新来源，否则路由注册了但端口没开：

```ts
const httpEnabled =
  cfg.http?.enabled ??
  Boolean(
    cfg.githubActions?.enabled ||
      cfg.feishu?.enabled ||
      cfg.wecom?.enabled ||
      cfg.acme?.enabled,
  );
```

启动日志在 `src/index.ts` 的 `startTriggers` 成功分支里，把 `acme` 加进 `names`：

```ts
cfg.triggers?.acme?.enabled ? "acme" : "",
```

HTTP 服务默认只监听 `127.0.0.1:8790`。要从外网收事件，自己加反向代理与 TLS，不要把端口直接暴露。

### 3.5 测试

测试文件放在 `tests/trigger-adapters.test.ts` 或新建 `tests/acme-trigger.test.ts`。至少覆盖四条：

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { makeTriggersHandler } from "../src/triggers/http";
import type { IncomingMessage } from "../src/types";

const cfg: Config = {
  ...DEFAULT_CONFIG,
  trigger: "/pisa",
  whitelist: { users: ["alice"], repos: ["pisa"] },
  triggers: {
    chatId: "acme-room",
    userId: "alice",
    repo: "pisa",
    acme: { enabled: true, tokenEnv: "ACME_TOKEN", users: ["alice"] },
  },
  channels: { cli: false },
  stateDir: ":memory:",
};

describe("acme 入口", () => {
  test("合法事件归一成一条消息", async () => {
    const got: IncomingMessage[] = [];
    const handler = makeTriggersHandler({
      cfg,
      handle: async (m) => { got.push(m); },
      env: { ACME_TOKEN: "s3cret" },
      now: () => 1_700_000_000_000,
    });
    const res = await handler(
      new Request("http://127.0.0.1:8790/acme/event", {
        method: "POST",
        headers: { "x-acme-token": "s3cret" },
        body: JSON.stringify({ id: "evt-1", text: "修复登录", actor: "alice" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe("/pisa 修复登录");
    expect(got[0]?.threadKey).toBe("acme:alice");
  });

  test("token 不对返回 401，且不投递", async () => {
    const got: IncomingMessage[] = [];
    const handler = makeTriggersHandler({
      cfg,
      handle: async (m) => { got.push(m); },
      env: { ACME_TOKEN: "s3cret" },
    });
    const res = await handler(
      new Request("http://127.0.0.1:8790/acme/event", {
        method: "POST",
        headers: { "x-acme-token": "wrong" },
        body: JSON.stringify({ id: "evt-2", text: "x", actor: "alice" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(got).toHaveLength(0);
  });

  test("白名单外的发送者被忽略但回 200", async () => {
    const got: IncomingMessage[] = [];
    const handler = makeTriggersHandler({
      cfg,
      handle: async (m) => { got.push(m); },
      env: { ACME_TOKEN: "s3cret" },
    });
    const res = await handler(
      new Request("http://127.0.0.1:8790/acme/event", {
        method: "POST",
        headers: { "x-acme-token": "s3cret" },
        body: JSON.stringify({ id: "evt-3", text: "x", actor: "bob" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(got).toHaveLength(0);
  });

  test("重复投递得到同一个 eventId，交给 Router 去重", async () => {
    const got: IncomingMessage[] = [];
    const handler = makeTriggersHandler({
      cfg,
      handle: async (m) => { got.push(m); },
      env: { ACME_TOKEN: "s3cret" },
    });
    const send = () =>
      handler(
        new Request("http://127.0.0.1:8790/acme/event", {
          method: "POST",
          headers: { "x-acme-token": "s3cret" },
          body: JSON.stringify({ id: "evt-4", text: "x", actor: "alice" }),
        }),
      );
    await send();
    await send();
    expect(got.map((m) => m.eventId)).toEqual(["acme:evt-4", "acme:evt-4"]);
  });
});
```

适配器单测只断言归一化结果，不在这里模拟去重；真正的「只建一单」由 Router 按触发身份落库时完成，`handle` 换成真实 Router 才生效。落库用例在 `tests/trigger-adapters.test.ts`，接新来源时照抄一份并把 `source` 换掉。

运行：

```bash
bun test tests/acme-trigger.test.ts
bun test tests/trigger-adapters.test.ts
```

### 3.6 手工验证

在服务端同一个环境里验证（`ACME_WEBHOOK_TOKEN` 已在环境中）：

```bash
curl -sS -X POST http://127.0.0.1:8790/acme/event \
  -H 'content-type: application/json' \
  -H "x-acme-token: $ACME_WEBHOOK_TOKEN" \
  -d '{"id":"evt-1","text":"/pisa 修复登录","actor":"alice"}'
```

预期返回 `{"ok":true}`，终端出现 `[pisa] 触发适配层 · acme` 与任务回执；再发一次同样的 `id`，不会新建任务。

### 3.7 同步文档

- `docs/domain.md` 的「来源」与身份字段如果语义有变，更新定义。
- `docs/operations.md` 的入口表加一行协议、路径、鉴权头与白名单维度。
- `CHANGELOG.md` 的 Unreleased 加一条 `新增`。
- `docs/architecture.md` 的入口表只加「内置触发源」一行，不复制本文步骤。

## 4. 加常驻型 Source

适合「对方不推送，只能拉」或「没有 HTTP，只有文件/长连接」的来源。参照 [`GithubWatcher`](../src/github-watcher.ts) 或 [`Scheduler`](../src/scheduler.ts)。

### 4.1 实现

新建 `src/acme-poller.ts`。沿用 3.3 的 `AcmeTriggerConfig`，另加一个 `intervalSec?: number`（代码里按最小 10 秒兜底）：

```ts
import type { Config } from "./config";
import type { Store } from "./store";
import type { IncomingMessage } from "./types";

interface AcmePollerDeps {
  cfg: Config;
  store: Store;
  enqueue: (m: IncomingMessage) => Promise<void> | void;
  now?: () => number;
  fetchEvents?: (since: string) => Promise<{ id: string; text: string; actor: string; at: string }[]>;
}

export class AcmePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly now: () => number;

  constructor(private readonly deps: AcmePollerDeps) {
    this.now = deps.now ?? Date.now;
    if (!deps.cfg.triggers?.acme?.enabled) return;
    if (!deps.cfg.triggers.chatId || !deps.cfg.triggers.userId) {
      throw new Error("triggers.chatId / triggers.userId 未配置");
    }
    const key = this.cursorKey();
    if (deps.store.getMeta(key) === null) {
      deps.store.setMeta(key, new Date(this.now()).toISOString());
    }
  }

  private cursorKey(): string {
    return `acme:since:${this.deps.cfg.repos[0]?.alias ?? "default"}`;
  }

  start(): void {
    const triggers = this.deps.cfg.triggers;
    if (!triggers?.acme?.enabled || this.timer) return;
    const every = Math.max(10, triggers.acme.intervalSec ?? 60) * 1000;
    this.timer = setInterval(() => void this.poll(), every);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    const since = this.deps.store.getMeta(this.cursorKey()) ?? new Date(this.now()).toISOString();
    try {
      const events = await (this.deps.fetchEvents?.(since) ?? []);
      for (const e of events) {
        await this.deps.enqueue({
          eventId: `acme:${e.id}`,
          channel: "acme",
          chatId: this.deps.cfg.triggers?.chatId ?? "",
          userId: this.deps.cfg.triggers?.userId ?? "",
          actor: e.actor,
          text: `/pisa ${e.text}`,
          repo: this.deps.cfg.triggers?.repo,
          threadKey: `acme:${e.actor}`,
          messageKey: e.id,
          receivedAt: this.now(),
        });
      }
      const latest = events.at(-1)?.at;
      if (latest) this.deps.store.setMeta(this.cursorKey(), latest);
    } catch (err) {
      console.warn(`[pisa] acme 拉取失败：${String(err).slice(0, 300)}`);
    } finally {
      this.polling = false;
    }
  }
}
```

### 4.2 装配

在 `src/index.ts` 里与 `GithubWatcher` 放同一段：

```ts
const acmePoller = new AcmePoller({ cfg, store, enqueue: (m) => router.handle(m) });
acmePoller.start();
```

在 `shutdown()` 里、`triggers?.stop()` 附近停止：

```ts
acmePoller.stop();
```

启动顺序有两条约束：`start()` 放在 `[pisa] ready` 之前，`channel.start()` 之前；`stop()` 放在 `router.stop()` 之前，避免关停后还投递新事件。

### 4.3 测试

用 `Store(":memory:")`、固定 `now` 和假的 `fetchEvents`，至少覆盖：

1. 第一轮拉到两条事件，`enqueue` 收到两条，游标推进到最后一条的 `at`。
2. 第二轮同样的数据不再投递（游标已推进）。
3. `fetchEvents` 抛错时不推进游标，下一轮还能重试。
4. `stop()` 后不再触发 `poll`，`start()` 重复调用只有一个 timer。

示例：

```ts
import { describe, expect, test } from "bun:test";
import { Store } from "../src/store";
import { DEFAULT_CONFIG } from "../src/config";
import { AcmePoller } from "../src/acme-poller";
import type { IncomingMessage } from "../src/types";

test("同一批事件只投递一次", async () => {
  const got: IncomingMessage[] = [];
  const store = new Store(":memory:");
  const events = [
    { id: "1", text: "a", actor: "alice", at: "2026-01-01T00:00:00.000Z" },
    { id: "2", text: "b", actor: "alice", at: "2026-01-01T00:00:01.000Z" },
  ];
  const poller = new AcmePoller({
    cfg: {
      ...DEFAULT_CONFIG,
      triggers: {
        chatId: "c",
        userId: "u",
        acme: { enabled: true, tokenEnv: "ACME_TOKEN" },
      },
    },
    store,
    enqueue: (m) => void got.push(m),
    now: () => 1_700_000_000_000,
    fetchEvents: async (since) => events.filter((e) => e.at > since),
  });
  await poller.poll();
  await poller.poll();
  expect(got).toHaveLength(2);
});
```

运行：

```bash
bun test tests/acme-poller.test.ts
```

定时器本身不在单测里跑；直接调用 `poll()` 验证逻辑，`start()` / `stop()` 只断言幂等。

## 5. 加 WorkerAdapter

Worker 只认三段：拼参数、备环境、解析一行输出。Router、Store、交付都不需要改。

### 5.1 实现

新建 `src/adapters/acme.ts`：

```ts
import type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";
import { buildPrompt } from "./omp";

export class AcmeAgentAdapter implements WorkerAdapter {
  readonly name = "acme";

  buildArgs(input: AdapterInput): string[] {
    return [
      input.cfg.command,
      ...input.cfg.extraArgs,
      "run",
      "--cwd",
      input.workdir,
      ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
      "--prompt",
      buildPrompt(input.task, { resume: Boolean(input.resume) }),
    ];
  }

  buildEnv(input: AdapterInput): Record<string, string> {
    return {
      PISA_WORKDIR: input.workdir,
      PISA_PROGRESS_FILE: input.progressFile,
    };
  }

  parseLine(line: string): ParsedLine {
    const text = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!text) return {};
    try {
      const event = JSON.parse(text) as { type?: string; text?: string };
      if (event.type === "assistant" && typeof event.text === "string") return { text: event.text };
      return { raw: text };
    } catch {
      return { raw: text };
    }
  }
}
```

契约细节：

- `buildArgs[0]` 必须是命令本身，后面才是参数；`cwd` 由 Worker 的 `spawn` 设为工作副本，不要自己再 `cd`。
- `buildEnv` 只能追加 `PISA_*` 这类运行时变量。用户凭据不会进来，除非在 `worker.envAllow` 里显式放行。
- `parseLine` 返回 `{ text }` 才会进摘要；返回 `{ raw }` 的内容只进失败尾部与日志。不要把工具调用、进度事件当摘要，否则最终回执会很吵。
- 进程必须非交互，退出码 0 表示成功，非 0 表示失败；最后 20 行 stderr/stdout 会进 `error`。
- `resume` 依赖 agent 自己写会话进度。当前只有 `extensions/pisa-worker.ts` 会往 `PISA_PROGRESS_FILE` 写 `{"type":"session","sessionId":"..."}`，`Router` 从进度文件落库。新 CLI 没有等价物时，`resume` 会起新会话，需要在文档里写明。

提示词复用 `buildPrompt`，其中已经包含工作目录、任务正文与禁止改 `.pisa/` 等约束。不要另写一份简化提示词，否则 guard 与续跑语义会分叉。

### 5.2 注册

在 `src/adapters/index.ts` 的注册表里加一行，导入对应类：

```ts
const REGISTRY: Record<string, () => WorkerAdapter> = {
  omp: () => new OmpAdapter(),
  acme: () => new AcmeAgentAdapter(),
};
```

配置里切换：

```json
{
  "worker": {
    "adapter": "acme",
    "command": "acme-agent",
    "timeoutSec": 3600,
    "idleTimeoutSec": 900,
    "concurrency": 2
  }
}
```

`worker.command` 仍然指向可执行文件；适配器只负责组装参数与环境。未注册的名字会在启动时抛 `未知的 Worker 适配器：...（可用：...）`。

### 5.3 测试

单元测试加在 `tests/adapter.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { AcmeAgentAdapter } from "../src/adapters/acme";
import type { AdapterInput } from "../src/adapters/types";

test("acme 适配器拼参数、注入环境、解析一行", () => {
  const adapter = new AcmeAgentAdapter();
  const input = {
    task: { id: "t_1", prompt: "修复登录" },
    workdir: "/tmp/work",
    extensionPath: "/tmp/ext.ts",
    progressFile: "/tmp/progress.jsonl",
    cfg: { adapter: "acme", command: "acme-agent", extraArgs: ["--fast"], timeoutSec: 60, concurrency: 1 },
    resume: true,
    resumeSessionId: "s-1",
  } as AdapterInput;

  const args = adapter.buildArgs(input);
  expect(args[0]).toBe("acme-agent");
  expect(args).toContain("--resume");
  expect(args).toContain("/tmp/work");

  expect(adapter.buildEnv(input)).toEqual({
    PISA_WORKDIR: "/tmp/work",
    PISA_PROGRESS_FILE: "/tmp/progress.jsonl",
  });

  expect(adapter.parseLine('{"type":"assistant","text":"完成"}')).toEqual({ text: "完成" });
  expect(adapter.parseLine("plain output")).toEqual({ raw: "plain output" });
});
```

端到端测试加在 `tests/worker.test.ts`，用一个打印固定 JSON 的 shell 脚本代替真实 CLI：

```bash
#!/bin/sh
printf '%s\n' '{"type":"assistant","text":"改好了"}'
exit 0
```

把脚本设为可执行，`worker.command` 指向它，`worker.adapter` 设为 `acme`，断言 `Worker.run()` 返回 `ok: true`、`summary` 为 `改好了`，并且子进程环境里能看到 `PISA_WORKDIR` 与 `PISA_PROGRESS_FILE`。

运行：

```bash
bun test tests/adapter.test.ts
bun test tests/worker.test.ts
```

### 5.4 手工验证

```bash
bun run src/index.ts --channel cli
```

在另一个终端投一个只读任务：

```bash
pisa task --repo pisa --wait "只回复 ok，不改文件"
```

看三件事：任务日志里有该 CLI 的原始输出；回执摘要是解析后的文字而不是整段 JSON；`pisa show` 里 `sessionId` 有值（只有 agent 写了会话事件才会有）。

## 6. 提 PR 前的检查

```bash
bun test
bunx tsc --noEmit
```

另外确认：

- 新来源的 `eventId` 前缀没有占用别人的命名空间（`webhook:`、`cron:`、`github:comment:`、`telegram:`）。
- 新适配器的错误信息带来源名，排障时能直接 grep。
- `CHANGELOG.md` 的 Unreleased 已加条目。
- 文档索引已更新：本页只加步骤，不复制 `architecture.md` 的设计理由。
