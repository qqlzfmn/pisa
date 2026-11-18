# 扩展指南

两个扩展点：**事件源（Source）** 把外部事件变成 pisa 的任务，**Worker 适配器（Adapter）** 把任务翻译成某个 agent 的命令行调用。两者都不改调度核心，接口与契约见 [架构 4.1 / 4.2](./architecture.md#41-workeradapter换-agent)，术语见 [领域模型](./domain.md)。

## 加事件源（Source）

事件源负责三件事：拉取或接收外部事件、组装成 `IncomingMessage`、交给 `router.handle`。参考实现是 `src/scheduler.ts`（cron）、`src/proactive.ts`（关键词与探针）、`src/github-watcher.ts`（评论轮询）。

### 1. 先定契约

在写代码前固定这五个值，它们决定去重与线程归属：

| 字段 | 取值规则 | 例子 |
| --- | --- | --- |
| `channel` | 入口名，同时作为触发器身份里的 `source`；不要复用已有入口名 | `rss` |
| `eventId` | 入口内唯一，必须带本入口的前缀；同一事件重投时保持相同 | `rss:42:2026-01-05T09:00:00Z` |
| `threadKey` | 同一讨论线程稳定不变 | `rss:42` |
| `messageKey` | 线程内消息标识，优先用平台 id | `42` |
| `version` | 编辑时间一类；没有版本概念就省略 | `2026-01-05T09:00:00Z` |

`eventId` 进 `events` 表做一次性占位；`channel` + `threadKey` + `messageKey` + `version` + 正文指纹共同决定触发器身份。正文相同的编辑会落到同一任务并留痕，改了正文才开新任务。规则见 [架构 4.2](./architecture.md#42-trigger加事件源)。

### 2. 加配置类型

`src/config.ts` 里加字段与类型，缺省不启用：

```ts
export interface RssConfig {
  enabled: boolean;
  chatId: string;
  userId: string;
}

export interface Config {
  // …已有字段
  rss?: RssConfig;
}
```

身份来源要与 `whitelist` 对齐：`chatId` 是回复目标，`userId` 是任务请求者。若入口无法确定请求者，不要用外部输入直接填，取 `whitelist.users[0]` 并在文档里写明。

### 3. 写事件源

新建 `src/rss-source.ts`。用注入的 `enqueue` 投递，不直接碰 `Router`；拉取函数也注入，测试才能不碰网络。

```ts
import type { RssConfig } from "./config";
import type { IncomingMessage } from "./types";

type Enqueue = (m: IncomingMessage) => Promise<void> | void;

export interface RssItem {
  id: string;
  updatedAt: string;
  author: string;
  body: string;
}

export class RssSource {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly cfg: RssConfig,
    private readonly enqueue: Enqueue,
    private readonly fetchItems: () => Promise<RssItem[]>,
  ) {}

  start(): void {
    if (!this.cfg.enabled || this.timer) return;
    this.timer = setInterval(
      () => void this.poll().catch((e) => console.warn(`[pisa] RSS 轮询失败：${String(e).slice(0, 300)}`)),
      30_000,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const item of await this.fetchItems()) {
        const msg: IncomingMessage = {
          eventId: `rss:${item.id}:${item.updatedAt}`,
          channel: "rss",
          chatId: this.cfg.chatId,
          userId: this.cfg.userId,
          actor: item.author,
          threadKey: `rss:${item.id}`,
          messageKey: item.id,
          version: item.updatedAt,
          text: item.body,
          isDirect: false,
        };
        await this.enqueue(msg);
      }
    } finally {
      this.polling = false;
    }
  }
}
```

要点：

- `poll` 不吞异常：定时器统一 `.catch` 记录，下一轮重试；`polling` 防重入，慢请求不会叠加。单条投递失败时不要推进游标，否则重启后这条事件会丢。
- 需要游标的入口把「上次成功位置」写 `store.getMeta` / `setMeta`（参考 `src/github-watcher.ts` 的 `github:since:<repo>`），重启后不重放。
- 需要「同一分钟只投一次」这类入口级幂等，先用 `store.claimEvent` 占位，再 `enqueue`（参考 `Scheduler.tick`）。

### 4. 装配与关闭

`src/index.ts` 在 `Router` 之后构造事件源，并把 `router.handle` 当 `enqueue`：

```ts
const rss = new RssSource(cfg.rss!, (m) => router.handle(m), fetchRssItems);
rss.start();
```

`fetchRssItems` 是你的真实拉取实现。关闭流程里补 `rss.stop()`，与 `proactive.stop()`、`scheduler.stop()` 放在一起，保证退出时不再投递。

### 5. 测试

测两件事：消息字段正确、同一事件的身份稳定。用 `makeTrigger` 直接验证去重契约，不需要起 Router：

```ts
import { describe, expect, test } from "bun:test";
import { makeTrigger } from "../src/trigger";

const base = {
  source: "rss",
  threadKey: "rss:42",
  messageKey: "42",
  actor: "u2",
  at: 0,
  text: "/pisa 修一下构建",
};

describe("rss 触发器身份", () => {
  test("同一版本重复投递得到同一身份", () => {
    const a = makeTrigger({ ...base, version: "2026-01-05T09:00:00Z" });
    const b = makeTrigger({ ...base, version: "2026-01-05T09:00:00Z" });
    expect(a.id).toBe(b.id);
  });

  test("同一消息的新版本是新身份", () => {
    const a = makeTrigger({ ...base, version: "2026-01-05T09:00:00Z" });
    const b = makeTrigger({ ...base, version: "2026-01-06T10:00:00Z" });
    expect(a.id).not.toBe(b.id);
  });
});
```

事件源本身用假拉取函数测字段，不联网：

```ts
import { describe, expect, test } from "bun:test";
import { RssSource } from "../src/rss-source";
import type { IncomingMessage } from "../src/types";

describe("RssSource", () => {
  test("把一条条目翻译成带稳定键的消息", async () => {
    const got: IncomingMessage[] = [];
    const source = new RssSource(
      { enabled: true, chatId: "c1", userId: "u1" },
      (m) => void got.push(m),
      async () => [{ id: "42", updatedAt: "2026-01-05T09:00:00Z", author: "u2", body: "/pisa 修一下构建" }],
    );

    await source.poll();

    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      eventId: "rss:42:2026-01-05T09:00:00Z",
      channel: "rss",
      chatId: "c1",
      userId: "u1",
      actor: "u2",
      threadKey: "rss:42",
      messageKey: "42",
      version: "2026-01-05T09:00:00Z",
    });
  });
});
```

跑新增测试与类型检查：

```bash
bun test tests/rss-source.test.ts
bunx tsc --noEmit
```

实际投递再用 CLI 通道打一次，确认白名单、仓库解析与任务创建都通：

```bash
bun run src/index.ts --channel cli
```

## 加 WorkerAdapter

适配器把「怎么启动 agent」和「怎么读输出」从 `Worker` 里隔离出来。接口只有四个成员，定义在 `src/adapters/types.ts`：

```ts
export interface WorkerAdapter {
  name: string;
  buildArgs(input: AdapterInput): string[];
  buildEnv(input: AdapterInput): Record<string, string>;
  parseLine(line: string): ParsedLine;
}
```

### 1. 实现适配器

新文件 `src/adapters/myagent.ts`，照着 `src/adapters/omp.ts` 的结构写：

```ts
import type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";

export class MyAgentAdapter implements WorkerAdapter {
  name = "myagent";

  buildArgs(input: AdapterInput): string[] {
    return [
      input.cfg.command,
      ...input.cfg.extraArgs,
      ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
      "--print",
      input.task.prompt,
    ];
  }

  buildEnv(input: AdapterInput): Record<string, string> {
    return {
      PISA_WORKDIR: input.workdir,
      PISA_PROGRESS_FILE: input.progressFile,
    };
  }

  parseLine(line: string): ParsedLine {
    const clean = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
    if (!clean) return {};
    try {
      const obj = JSON.parse(clean) as { type?: string; text?: string };
      return obj.type === "final" && typeof obj.text === "string" ? { text: obj.text } : {};
    } catch {
      return { raw: clean };
    }
  }
}
```

契约：

- `buildArgs[0]` 必须是 `input.cfg.command`。测试里把 `command` 换成脚本就能接管整个调用。
- `buildEnv` 必须给 `PISA_PROGRESS_FILE`，否则卡死检测拿不到进度；`PISA_WORKDIR` 是给 skill 的落点提示。不要转发 daemon 的环境变量，Worker 只按 `worker.envAllow` 注入。
- `parseLine` 只返回**完整的助手消息**，不要把流式片段或用户回显塞进摘要；无法解析的行返回 `{raw}`，它会进入失败时的错误尾部。
- 会话续跑：`resumeSessionId` 非空时才追加恢复参数。Router 轮询 `PISA_PROGRESS_FILE`，从 `extensions/pisa-worker.ts` 在 `session_start` 写入的 `{"type":"session","sessionId":"…"}` 行取会话 id。新适配器要么能加载这个扩展（参考 `OmpAdapter` 传 `-e input.extensionPath`），要么在 agent 侧写同样的进度行；两者都没有时，任务中断后无法 `resume`，重启会判 `failed`。
- 超时、取消、空闲检测由 `Worker` 统一处理，适配器不要自己起 watchdog。

### 2. 注册

`src/adapters/index.ts` 的注册表加一行：

```ts
const REGISTRY: Record<string, () => WorkerAdapter> = {
  omp: () => new OmpAdapter(),
  myagent: () => new MyAgentAdapter(),
};
```

未注册的名字会得到 `未知的 Worker 适配器：X（可用：omp, myagent）`。

### 3. 配置

```json
{
  "worker": {
    "adapter": "myagent",
    "command": "myagent"
  }
}
```

`adapter` 决定用哪个实现，`command` 决定可执行文件；两者分开是为了测试与换路径。其余 `extraArgs`、`timeoutSec`、`idleTimeoutSec` 由 `Worker` 读取。

### 4. 测试

单元测试覆盖三个方法。`AdapterInput` 用一个完整夹具，避免 `as` 断言：

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { getAdapter } from "../src/adapters";
import type { AdapterInput } from "../src/adapters/types";

function input(over: Partial<AdapterInput> = {}): AdapterInput {
  return {
    task: {
      id: "t_demo",
      source: "cli",
      channel: "cli",
      chatId: "c1",
      requester: "u1",
      repo: "demo",
      prompt: "加一行说明",
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
    },
    workdir: "/tmp/demo",
    extensionPath: "/repo/extensions/pisa-worker.ts",
    progressFile: "/tmp/demo/progress.jsonl",
    cfg: { ...DEFAULT_CONFIG.worker, command: "myagent" },
    ...over,
  };
}

describe("MyAgentAdapter", () => {
  test("参数从 command 开始，恢复时带会话", () => {
    const adapter = getAdapter("myagent");
    expect(adapter.buildArgs(input())).toEqual(["myagent", "--print", "加一行说明"]);
    expect(adapter.buildArgs(input({ resumeSessionId: "s1" }))).toEqual([
      "myagent",
      "--resume",
      "s1",
      "--print",
      "加一行说明",
    ]);
  });

  test("注入进度文件，不泄漏 daemon 环境", () => {
    expect(getAdapter("myagent").buildEnv(input())).toEqual({
      PISA_WORKDIR: "/tmp/demo",
      PISA_PROGRESS_FILE: "/tmp/demo/progress.jsonl",
    });
  });

  test("只取完整消息，解析失败保留原文", () => {
    const adapter = getAdapter("myagent");
    expect(adapter.parseLine('{"type":"final","text":"完成"}')).toEqual({ text: "完成" });
    expect(adapter.parseLine("not json")).toEqual({ raw: "not json" });
  });
});
```

集成测试用假命令跑一遍 `Worker`，验证真实子进程的环境与退出码。参考 `tests/worker.test.ts`：

```ts
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "../src/worker";

const dir = mkdtempSync(join(tmpdir(), "pisa-myagent-"));
const script = join(dir, "fake.sh");
writeFileSync(script, "#!/bin/sh\nexec env\n");
chmodSync(script, 0o755);

const worker = new Worker(
  { adapter: "myagent", command: script, timeoutSec: 30, extraArgs: [], concurrency: 1 },
  join(dir, "state"),
);
```

跑完整检查：

```bash
bun test tests/adapters.test.ts tests/worker.test.ts
bunx tsc --noEmit
```

### 5. 手工验收

真实入口跑一条任务，确认参数、输出解析与摘要都对：

```bash
bun run src/index.ts --channel cli
```

看任务详情与日志：

```bash
bun run src/cli.ts show "<任务号>"
bun run src/cli.ts logs "<任务号>" --tail 100
```

换适配器后先跑一个小任务，再验证中断续跑：任务执行中重启主进程，恢复后任务应进入 `paused`，在会话里输入 `/pisa resume <任务号>` 能接着原会话执行。适配器没输出 session 行时，此步会变成 `failed`，属于预期。
