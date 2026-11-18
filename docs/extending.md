# 扩展指南：加 Source 与 Adapter

两类扩展点，边界不同：

- **Source（触发源）**：把外部事件翻译成 `IncomingMessage` 交给 Router。实现 `TriggerAdapter`，或自己驱动并直接调 `router.handle`。
- **Adapter（Worker 适配器）**：把「怎么调用一个 agent、怎么读它的输出」从调度逻辑里拆出来。实现 `WorkerAdapter`。

接口契约见 [architecture.md](./architecture.md) 第 4 节；名词见 [domain.md](./domain.md)；装配失败的排查见 [deployment.md](./deployment.md)。

先读代码：

```bash
sed -n '1,120p' src/triggers/types.ts
sed -n '1,130p' src/triggers/http.ts
sed -n '1,60p' src/adapters/types.ts
```

## 1. 加一个 Source

### 1.1 先选形态

| 形态 | 适用 | 落点 |
| --- | --- | --- |
| HTTP webhook | 对方能推送到 URL；验签后可重试 | 实现 `TriggerAdapter<HttpTriggerRequest, Payload>`，注册到 `makeTriggersHandler` |
| 自驱来源 | 本地文件变化、轮询、定时器；没有入站请求 | 自己监听并调 `handle(msg)`，在 `startTriggers` 里启动与停止 |

两种形态都只做三件事：鉴权、把载荷归一化成 `IncomingMessage`、给出稳定的去重键。任务状态、白名单、去重落库、回执都在 Router 里，不要在 Source 里重做。

### 1.2 加配置类型

`src/config.ts` 的 `TriggersConfig` 是 Source 的配置面。按现有形状加一个可选块：

```ts
/** Acme 任务事件：Token 校验，来源白名单即权限边界 */
export interface AcmeTriggerConfig {
  enabled: boolean;
  /** 校验 token 所在环境变量 */
  tokenEnv: string;
  /** 允许的来源 id；为空不限制 */
  sources?: string[];
}
```

并把字段挂到 `TriggersConfig`：

```ts
export interface TriggersConfig {
  chatId?: string;
  userId?: string;
  repo?: string;
  http?: { enabled: boolean; port?: number };
  // …
  acme?: AcmeTriggerConfig;
}
```

配置是 JSON 浅合并、不做 schema 校验（`loadConfig` 只处理路径与环境变量覆盖）。新增字段不需要改解析逻辑；需要相对路径时在 `loadConfig` 的 `triggers` 分支里解析。

`triggers.chatId` / `triggers.userId` 是**必填的入口身份**：`chatId` 是回执落到哪个会话，`userId` 是任务的 `requester`（必须是 `whitelist.users` 的一员）。平台侧真实发送人只写进 `actor`。

### 1.3 实现适配器

在 `src/triggers/` 下新建文件 `acme.ts`。三段职责固定：

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
  event: string;
  id: string;
  text: string;
  source: string;
  at: string;
}

export interface AcmeOptions {
  config: AcmeTriggerConfig;
  /** 与平台侧一致的 token；为空时入口不可用 */
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
    const given = req.headers.get("x-acme-token") ?? "";
    if (!safeEqual(given, this.opts.token)) throw new TriggerError(401, "token 校验失败");

    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body);
    } catch {
      throw new TriggerError(400, "请求体不是合法 JSON");
    }
    const body = parsed as Record<string, unknown>;
    const event = typeof body.event === "string" ? body.event : "";
    const id = typeof body.id === "string" ? body.id : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (!event || !id) throw new TriggerError(400, "载荷缺少 event / id");
    return { event, id, text, source: String(body.source ?? ""), at: String(body.at ?? "") };
  }

  normalize(payload: AcmePayload): TriggerOutcome | null {
    // 协议级探针：只回执，不建任务
    if (payload.event === "ping") {
      return { reply: { body: JSON.stringify({ ok: true }), contentType: "application/json" } };
    }
    if (payload.event !== "task.requested") return null;
    if (!payload.text.trim()) return null;

    const allowed = this.opts.config.sources ?? [];
    if (allowed.length > 0 && !allowed.includes(payload.source)) {
      throw new TriggerError(403, `来源 ${payload.source} 不在白名单`);
    }

    const dedupeKey = this.dedupeKey(payload);
    return {
      event: {
        dedupeKey,
        message: {
          eventId: dedupeKey,
          channel: "acme",
          chatId: this.opts.chatId,
          userId: this.opts.userId,
          actor: payload.source || "acme",
          repo: this.opts.repo,
          isDirect: true,
          text: commandText(this.opts.trigger, payload.text),
          threadKey: `acme:${payload.id}`,
          messageKey: payload.id,
          version: payload.at,
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

硬性约束：

- 密钥只从环境变量取（`env[config.tokenEnv]`），缺失时回 503，不退化免签。
- 验签在 `verify`；白名单与协议语义在 `normalize`；两者都用 `TriggerError(status, message)` 拒绝，不要抛裸 `Error`。
- `eventId` 用 `acme:` 命名空间，避免与 `telegram:`、`github:comment:`、`cron:`、`webhook:` 撞键。
- `userId` 固定取 `triggers.userId`，绝不从载荷里取，否则持钥方可以冒充白名单用户。
- `threadKey` 表达「同一件事的后续消息」，`messageKey` 表达「这件事的哪条消息」，`version` 表达编辑版本。三者给对，编辑与线程续跑才成立。
- 返回 `null` 表示忽略（探针、无关事件），返回 `reply` 表示只回执不建任务。

### 1.4 装配

HTTP 形态：在 `src/triggers/http.ts` 的 `makeTriggersHandler` 里加路由，和现有三个入口同样三步：要求身份、构造适配器、放进 `routes`。

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

并在 `httpEnabled` 的判定里加上它（`src/triggers/index.ts`）：

```ts
const httpEnabled =
  cfg.http?.enabled ??
  Boolean(cfg.githubActions?.enabled || cfg.feishu?.enabled || cfg.wecom?.enabled || cfg.acme?.enabled);
```

自驱形态：在 `startTriggers` 里启动，并把 `stop` 推进 `stops`，保证启动失败时已开的监听被回收：

```ts
if (cfg.acme?.enabled) {
  if (!cfg.chatId || !cfg.userId) {
    throw new Error("triggers.acme 已启用，但 triggers.chatId / triggers.userId 未配置");
  }
  const source = new AcmePoller({ config: cfg.acme, /* … */ });
  source.start(deps.handle);
  stops.push(() => source.stop());
}
```

`startTriggers` 的失败只记日志、不让进程退出（`src/index.ts` 如此装配）；因此自驱来源必须在 `start()` 里自己校验前置条件并抛错，不要静默不工作。

最后从 `src/triggers/index.ts` 导出类与构造函数，供测试与后续装配使用。

### 1.5 配置示例

```json
{
  "triggers": {
    "chatId": "ops-room",
    "userId": "alice",
    "repo": "demo",
    "acme": { "enabled": true, "tokenEnv": "ACME_TRIGGER_TOKEN", "sources": ["ci"] }
  }
}
```

启动前导出密钥：

```bash
export ACME_TRIGGER_TOKEN="$(cat "$HOME/.pisa/acme_token")"
```

### 1.6 测试

照 `tests/trigger-adapters.test.ts` 的写法：不走网络，直接调 handler 或适配器，用假的 `env`、固定的 `now`、收集 `handle` 收到的消息。至少覆盖：

| 用例 | 断言 |
| --- | --- |
| 缺少密钥 | 503，未调用 handle |
| 签名/token 不匹配 | 401，未调用 handle |
| 白名单外来源 | 403，未调用 handle |
| 探针/无关事件 | 200 且不回建任务（`normalize` 返回 null 或只回 `reply`） |
| 正常事件 | `handle` 收到一条消息，`channel`、`repo`、`chatId`、`userId`、`threadKey`、`messageKey`、`text`（带触发词）正确 |
| 同一事件重投 | 两次都 200，`messageKey`/`eventId` 相同（Router 侧据此去重） |
| 未知路径 | 404 |

```bash
bun test tests/trigger-adapters.test.ts
bun test tests/trigger-adapters.test.ts -t acme
```

### 1.7 收尾

- `docs/operations.md` 的入口表加一行（路径、鉴权头、白名单字段）。
- `docs/architecture.md` 4.2 的内置入口表加一行。
- `docs/deployment.md` 只在新增端口时改（HTTP 入口共用 `triggers.http.port`，通常不用改）。
- `CHANGELOG.md` 的 `Unreleased / 新增` 写一条。

## 2. 加一个 Adapter

### 2.1 接口

```ts
export interface WorkerAdapter {
  name: string;
  buildArgs(input: AdapterInput): string[];
  buildEnv(input: AdapterInput): Record<string, string>;
  parseLine(line: string): ParsedLine;
}
```

`AdapterInput` 提供 `task`、`workdir`、`extensionPath`、`progressFile`、`cfg`（即 `worker` 配置）、`resume`、`resumeSessionId`。适配器只做「描述一次进程调用」和「解析一行输出」，**不做**重试、超时、并发、交付；这些在 `src/worker.ts` 与 `src/router.ts`。

### 2.2 实现

在 `src/adapters/` 下新建文件 `acme.ts`：

```ts
import type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";
import { buildPrompt } from "./omp";

export class AcmeAdapter implements WorkerAdapter {
  name = "acme";

  buildArgs(input: AdapterInput): string[] {
    const args = [input.cfg.command, ...input.cfg.extraArgs];
    if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
    args.push("--dir", input.workdir, "--extension", input.extensionPath);
    args.push("--prompt", buildPrompt(input.task, { resume: input.resume === true }));
    return args;
  }

  buildEnv(input: AdapterInput): Record<string, string> {
    return { PISA_WORKDIR: input.workdir, PISA_PROGRESS_FILE: input.progressFile };
  }

  parseLine(line: string): ParsedLine {
    const trimmed = line.trim();
    if (!trimmed) return {};
    try {
      const obj = JSON.parse(trimmed) as { type?: unknown; text?: unknown };
      if (obj.type === "done" && typeof obj.text === "string") return { text: obj.text };
      return { raw: trimmed };
    } catch {
      return { raw: trimmed };
    }
  }
}
```

要点：

- `buildArgs` 第一项固定 `input.cfg.command`，用于让用户覆盖二进制路径。
- 恢复执行时把 `resumeSessionId` 作为会话参数传入；`resume` 只影响提示词（`buildPrompt` 的核对段落），与会话 id 是否存在无关。
- `buildEnv` 只加适配器需要的变量。Worker 进程的环境变量由 `src/worker.ts` 按 `worker.envAllow` 白名单过滤，适配器返回的变量不受该白名单限制，因此不要在这里透传宿主环境。
- `parseLine` 返回助手完整消息时用 `text`，解析不了的用 `raw`（进日志，不影响结论）。
- 进程退出码 0 视为成功；非 0 由 `WorkerRunner` 映射成失败。

### 2.3 注册

`src/adapters/index.ts`：

```ts
import { AcmeAdapter } from "./acme";

const REGISTRY: Record<string, () => WorkerAdapter> = {
  omp: () => new OmpAdapter(),
  acme: () => new AcmeAdapter(),
};
```

注册后 `getAdapter("acme")` 可用，未知名字仍报 `未知的 Worker 适配器：x（可用：…）`。

### 2.4 启用

```json
{
  "worker": {
    "adapter": "acme",
    "command": "acme",
    "timeoutSec": 3600,
    "idleTimeoutSec": 900,
    "extraArgs": []
  }
}
```

`command` 必须在守护进程的 `PATH` 里；launchd 下 PATH 由 plist 决定（`scripts/install-launchd.sh` 已包含 `~/.bun/bin`）。

### 2.5 测试

照 `tests/adapter.test.ts`：构造一个 `Task` 与 `AdapterInput`，断言参数顺序与关键值、环境变量、行解析。至少覆盖：

| 用例 | 断言 |
| --- | --- |
| 新任务 | `buildArgs` 含命令、工作目录、扩展路径、完整需求正文 |
| 恢复任务 | 参数含 `resumeSessionId`，提示词带恢复段落 |
| 输出解析 | 完整消息返回 `text`；非 JSON 行返回 `raw`；空行返回 `{}` |
| 环境 | `buildEnv` 只含约定的键 |
| 未注册名字 | `getAdapter("nope")` 抛错并列出可用适配器 |

```bash
bun test tests/adapter.test.ts
```

### 2.6 收尾

- README「换 agent」段落与 FAQ 若写了「目前只有 omp」，同步改。
- `docs/operations.md` 的 `worker` 配置段与 `pisa.config.example.json` 的说明同步。
- `CHANGELOG.md` 的 `Unreleased / 新增` 写一条。

## 3. 验证

改完扩展点后按顺序跑：

```bash
bun test tests/trigger-adapters.test.ts tests/adapter.test.ts
bun test
bun run typecheck
```

用一个真实进程验证装配，而不是只看测试。先起一个进程：

```bash
bun run src/index.ts --channel cli
```

另开终端打入口（按 1.3 的例子，需要 `ACME_TRIGGER_TOKEN` 已导出且配置里的 `triggers.acme.enabled` 为真）：

```bash
curl -fsS -X POST http://127.0.0.1:8790/acme/event \
  -H "x-acme-token: $ACME_TRIGGER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"event":"task.requested","id":"e1","text":"把 README 的错别字修掉","source":"ci"}'
```

回执 `{"ok":true}` 表示鉴权与路由通过；任务是否真的创建看第一个终端或 `bun run src/cli.ts status`。
