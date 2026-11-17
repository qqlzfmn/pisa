# 扩展指南

三种扩展点：新增事件来源（Source）、新增 Worker 适配器（Adapter）、新增通道（Channel）。先按需求选对位置，再动代码。

相关文档：[架构](./architecture.md) · [领域模型](./domain.md) · [部署与排障](./deployment.md)

## 选哪个扩展点

| 需求 | 扩展点 | 是否改 Router |
| --- | --- | --- |
| 从新的系统接事件（工单、CI、消息队列） | Source | 不改 |
| 换一种 agent 命令行或输出格式 | Worker 适配器 | 不改 |
| 新增双向聊天通道（如飞书、Slack） | Channel | 不改 |
| 改命令、鉴权、任务状态语义 | 核心代码 | 会改 |

Source 和 Adapter 都通过稳定接口接入，Router 不感知具体实现。

## 新增 Source

Source 负责三件事：发现事件、生成稳定的 `IncomingMessage`、交给 Router。它不直接建任务、不写数据库、不执行代码。

### 1. 定义事件契约

先确定事件唯一键。`eventId` 必须满足：同一业务事件无论投递多少次都得到同一个字符串。推荐 `<source>:<type>:<key>`。

```text
event-file:<事件 id>
ci:build:<build id>
ticket:updated:<ticket id>:<updated_at>
```

不要用随机数、当前时间或进程内自增作为唯一键。Router 在鉴权之前调用 `claimEvent`，事件一旦被领取，重复投递会被静默丢弃。

### 2. 实现 Source 类

Source 没有强制接口，但应遵循现有写法：构造函数接收依赖，`start()` 启动轮询，`stop()` 清理定时器，并把实际工作放在可单独测试的方法里。

新增 `src/sources/event-file.ts`：

```ts
import { readFile } from "node:fs/promises";
import type { Config } from "../config";
import type { IncomingMessage } from "../types";

type Enqueue = (m: IncomingMessage) => Promise<void> | void;

export interface EventFileSourceDeps {
  cfg: Config;
  enqueue: Enqueue;
}

/**
 * 读取 JSONL 事件文件，每行一条：
 * {"id":"42","prompt":"修登录"}
 * 文件只能追加，且每次写入完整一行。
 */
export class EventFileSource {
  private timer: ReturnType<typeof setInterval> | null = null;
  private offset = 0;

  constructor(private deps: EventFileSourceDeps) {}

  start(): void {
    const every = Math.max(5, this.deps.cfg.eventFile?.intervalSec ?? 60) * 1000;
    const run = () => {
      void this.tick().catch((error) => console.error("[event-file] 轮询失败", error));
    };
    this.timer = setInterval(run, every);
    run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const cfg = this.deps.cfg.eventFile;
    if (!cfg?.enabled) return;

    const lines = (await readFile(cfg.path, "utf8")).split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length < this.offset) this.offset = 0;

    for (const line of lines.slice(this.offset)) {
      if (!line.trim()) continue;
      let event: { id?: string; prompt?: string };
      try {
        event = JSON.parse(line) as { id?: string; prompt?: string };
      } catch {
        continue;
      }
      if (!event.id || !event.prompt) continue;

      await this.deps.enqueue({
        eventId: `event-file:${event.id}`,
        channel: "event-file",
        chatId: cfg.chatId,
        userId: cfg.userId,
        text: event.prompt,
        isDirect: true,
        receivedAt: Date.now(),
      });
    }
    this.offset = lines.length;
  }
}
```

要点：

- `enqueue` 只调用一次，不吞异常。Router 的失败会向上传播，由 Source 决定是否记录。
- 所有事件都带 `channel`、`chatId`、`userId`；否则回执和白名单无法工作。
- 轮询间隔设置下限，避免配置写成 0 时打满 CPU。
- 进程启动后会重读文件；旧事件靠 `eventId` 去重，不依赖内存 offset。

### 3. 增加配置字段

在 [`src/config.ts`](../src/config.ts) 中加类型和默认值：

```ts
export interface EventFileConfig {
  enabled: boolean;
  path: string;
  chatId: string;
  userId: string;
  intervalSec?: number;
}

export interface Config {
  // ...现有字段
  eventFile?: EventFileConfig;
}
```

在 `DEFAULT_CONFIG` 中补默认值：

```ts
export const DEFAULT_CONFIG: Config = {
  // ...现有字段
  eventFile: { enabled: false, path: "", chatId: "", userId: "", intervalSec: 60 },
};
```

新增顶层字段会被 `merge` 的展开运算保留；如果是嵌套对象且需要部分覆盖，还要在 `merge` 里加一层合并。默认关闭，避免升级后行为突变。

配置示例：

```json
{
  "eventFile": {
    "enabled": true,
    "path": "/absolute/path/to/events.jsonl",
    "chatId": "ops",
    "userId": "ci",
    "intervalSec": 30
  }
}
```

### 4. 接到进程入口

在 [`src/index.ts`](../src/index.ts) 中装配、启动、停止：

```ts
import { EventFileSource } from "./sources/event-file";

const eventFile = new EventFileSource({
  cfg,
  enqueue: (m) => router.handle(m),
});

// 现有组件启动之后
if (cfg.eventFile?.enabled) eventFile.start();

// 关闭流程中，store.close() 之前
eventFile.stop();
```

顺序要求：

- 在 `channel.start(...)` 和 `router.start()` 之后启动，确保 Router 已经能接事件。
- 在 `store.close()` 之前停止，避免停止过程中还有事件写入数据库。
- `stop()` 必须可重复调用；关闭流程可能被信号触发多次。

### 5. 写测试

Source 的测试不需要真实网络或真实 agent。用临时文件和收集数组即可：

新增 `tests/event-file-source.test.ts`：

```ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import { EventFileSource } from "../src/sources/event-file";
import type { IncomingMessage } from "../src/types";

describe("EventFileSource", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pisa-source-"));
    file = join(dir, "events.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeSource(got: IncomingMessage[]): EventFileSource {
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      eventFile: { enabled: true, path: file, chatId: "ops", userId: "ci" },
    };
    return new EventFileSource({ cfg, enqueue: (m) => { got.push(m); } });
  }

  test("每行转成稳定事件，追加后只投递新增行", async () => {
    writeFileSync(file, '{"id":"42","prompt":"修登录"}\n', "utf8");
    const got: IncomingMessage[] = [];
    const source = makeSource(got);

    await source.tick();
    await source.tick();
    expect(got).toHaveLength(1);
    expect(got[0]!.eventId).toBe("event-file:42");
    expect(got[0]!.text).toBe("修登录");

    appendFileSync(file, '{"id":"43","prompt":"补测试"}\n', "utf8");
    await source.tick();
    expect(got.map((m) => m.eventId)).toEqual(["event-file:42", "event-file:43"]);
  });

  test("坏行跳过，不影响后续事件", async () => {
    writeFileSync(file, 'not json\n{"id":"7","prompt":"修构建"}\n', "utf8");
    const got: IncomingMessage[] = [];
    await makeSource(got).tick();
    expect(got.map((m) => m.eventId)).toEqual(["event-file:7"]);
  });
});
```

测试原则：

- 断言 `eventId`、`text`、`chatId`、`userId` 这些 Router 真正消费的字段。
- 覆盖重复调用、追加事件、坏输入。
- 如果 Source 调用外部命令，注入 runner，不在测试里跑真实 `gh`、`curl` 或付费 API。
- 去重本身由 Store 测试；Source 只保证同一个业务事件生成同一个 `eventId`。

### 6. 验证

```bash
bun test tests/event-file-source.test.ts
bunx tsc --noEmit
bun test
```

手工冒烟：启用配置，追加一行事件，启动 CLI，确认出现接单回执和任务记录。

```bash
bun run src/index.ts --channel cli
sqlite3 -header -column .pisa/pisa.db "select id,status,repo,prompt from tasks order by created_at desc limit 3;"
```

## 新增 Worker 适配器

适配器只做三件事：拼命令行、拼环境变量、解析输出。超时、取消、工作目录、状态迁移都由 [`src/worker.ts`](../src/worker.ts) 负责，不要在适配器里重复实现。

接口定义在 [`src/adapters/types.ts`](../src/adapters/types.ts)：

```ts
export interface WorkerAdapter {
  name: string;
  buildArgs(input: AdapterInput): string[];
  buildEnv(input: AdapterInput): Record<string, string>;
  parseLine(line: string): ParsedLine;
}
```

`AdapterInput` 包含：

| 字段 | 用途 |
| --- | --- |
| `task` | 任务本体，用来生成提示词。 |
| `workdir` | 子进程工作目录，即任务 worktree。 |
| `extensionPath` | pisa 的 Worker 扩展绝对路径。 |
| `progressFile` | 进度 JSONL 路径，应传给 agent。 |
| `cfg` | `worker` 配置：`command`、`extraArgs`、`timeoutSec`、`concurrency`。 |
| `resumeSessionId` | 恢复任务时的原会话 id；新任务为空。 |

### 1. 实现适配器

新增 `src/adapters/myworker.ts`。假设该 agent 接受 `--prompt`、`--cwd`、`--json`，恢复时接受 `--resume <id>`，输出每行一个 JSON：

```ts
import { buildPrompt } from "./omp";
import type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";

export class MyWorkerAdapter implements WorkerAdapter {
  name = "myworker";

  buildArgs(input: AdapterInput): string[] {
    return [
      input.cfg.command,
      ...input.cfg.extraArgs,
      "--extension",
      input.extensionPath,
      ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
      "--prompt",
      buildPrompt(input.task, { resume: Boolean(input.resumeSessionId) }),
      "--cwd",
      input.workdir,
      "--json",
    ];
  }

  buildEnv(input: AdapterInput): Record<string, string> {
    return {
      MYWORKER_CWD: input.workdir,
      MYWORKER_PROGRESS: input.progressFile,
    };
  }

  parseLine(line: string): ParsedLine {
    const clean = line.trim();
    if (!clean) return {};
    try {
      const event = JSON.parse(clean) as { type?: string; text?: string };
      return event.type === "assistant" && event.text ? { text: event.text } : {};
    } catch {
      return { raw: clean };
    }
  }
}
```

`buildPrompt` 当前从 [`src/adapters/omp.ts`](../src/adapters/omp.ts) 导出，并由 [`src/adapters/index.ts`](../src/adapters/index.ts) 转发。它负责统一的任务描述、续跑提示和约束。

约定：

- `buildArgs` 返回的数组直接交给 `Bun.spawn`，不经过 shell。不要写 `|`、`&&`、重定向；需要管道就自己在代码里处理。
- 第一个元素是可执行文件。通常用 `cfg.command`，让部署方决定路径。
- `buildEnv` 的返回值叠加在 `process.env` 上，只需返回新增变量。
- `parseLine` 只对**完整**的助手消息返回 `text`。增量 delta 也返回会在最终摘要里重复。
- `raw` 用于无法解析的行；Worker 会在失败时取最后一段 `raw` 作为错误信息。
- 恢复语义：`resumeSessionId` 非空时，参数必须让 agent 接回原会话。否则 `resume` 会变成从当前 worktree 重新开始。
- 退出码由 agent 决定；`0` 且没有文本时摘要为 `（Worker 未返回文字摘要）`。

### 2. 注册适配器

在 [`src/adapters/index.ts`](../src/adapters/index.ts) 的 `REGISTRY` 中增加一项：

```ts
import { MyWorkerAdapter } from "./myworker";

const REGISTRY: Record<string, () => WorkerAdapter> = {
  omp: () => new OmpAdapter(),
  myworker: () => new MyWorkerAdapter(),
};
```

`getAdapter` 找不到名称时会抛出 `未知的 Worker 适配器：<名称>（可用：...）`，启动阶段就会失败，不会静默回退到 `omp`。

### 3. 配置

```json
{
  "worker": {
    "adapter": "myworker",
    "command": "myworker",
    "timeoutSec": 3600,
    "extraArgs": [],
    "concurrency": 2
  }
}
```

`command` 必须是进程能直接找到的可执行文件。launchd 的 PATH 比交互 shell 窄，必要时写绝对路径。

### 4. 写测试

新增 `tests/myworker-adapter.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { getAdapter } from "../src/adapters";
import { DEFAULT_CONFIG, type Config } from "../src/config";
import type { Task } from "../src/types";

const task: Task = {
  id: "t_20260101_abcdef",
  source: "test",
  channel: "cli",
  chatId: "local",
  requester: "tester",
  repo: "pisa",
  prompt: "修登录",
  status: "running",
  branch: "pisa/t_20260101_abcdef",
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
  startedAt: 0,
  endedAt: null,
  cancelRequested: false,
};

const cfg: Config = DEFAULT_CONFIG;

function input(resumeSessionId: string | null = null) {
  return {
    task,
    workdir: "/tmp/pisa-work",
    extensionPath: "/tmp/pisa-worker.ts",
    progressFile: "/tmp/pisa-progress.jsonl",
    cfg: cfg.worker,
    resumeSessionId,
  };
}

describe("myworker adapter", () => {
  test("拼接参数并透传扩展与工作目录", () => {
    const adapter = getAdapter("myworker");
    expect(adapter.buildArgs(input())).toEqual([
      "omp",
      "--extension",
      "/tmp/pisa-worker.ts",
      "--prompt",
      expect.any(String),
      "--cwd",
      "/tmp/pisa-work",
      "--json",
    ]);
  });

  test("恢复时带上会话 id", () => {
    const args = getAdapter("myworker").buildArgs(input("session-1"));
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("session-1");
  });

  test("只把完整助手消息作为摘要", () => {
    const adapter = getAdapter("myworker");
    expect(adapter.parseLine('{"type":"assistant","text":"完成"}')).toEqual({ text: "完成" });
    expect(adapter.parseLine('{"type":"delta","text":"完成"}')).toEqual({});
    expect(adapter.parseLine("plain output")).toEqual({ raw: "plain output" });
  });

  test("未知名称直接失败", () => {
    expect(() => getAdapter("missing")).toThrow("未知的 Worker 适配器");
  });
});
```

测试原则：

- 断言实际参数顺序和恢复分支，而不只是“返回了数组”。
- 覆盖 `parseLine` 的完整消息、增量丢弃、无法解析三类输入。
- 不启动真实 agent；需要端到端验证时用 `worker.command` 指向一个本地假脚本。

### 5. 验证

```bash
bun test tests/myworker-adapter.test.ts
bunx tsc --noEmit
bun test
```

端到端冒烟时，把 `worker.command` 指向一个会输出 JSON 行并退出 0 的脚本，确认任务能进入 `succeeded` 且摘要正确。

## 新增 Channel

只有需要“收消息并回执”时才实现 Channel；只产生事件用 Source 即可。

接口在 [`src/types.ts`](../src/types.ts)：

```ts
export interface ChannelAdapter {
  name: string;
  start(onMessage: (m: IncomingMessage) => Promise<void> | void): Promise<void>;
  send(chatId: string, text: string): Promise<DeliveryReceipt | void>;
  stop(): Promise<void>;
  setCommands?(commands: ReadonlyArray<{ command: string; description: string }>): Promise<void>;
}
```

步骤：

1. 新建 `src/channels/<name>.ts`，实现 `start`、`send`、`stop`。
2. `start` 收到消息后构造稳定的 `eventId`，调用传入的 `onMessage`，不要自己调用 Router。
3. `send` 返回 `{ messageId }` 时，Router 会把“回复这条消息”绑定到任务。
4. 支持命令菜单就实现 `setCommands`；不支持可以不写。
5. 在 [`src/index.ts`](../src/index.ts) 的通道选择分支中实例化，并加入关闭流程。
6. 测试用假 transport 或假 HTTP，不连真实服务；覆盖事件 id 稳定性、回执 id、关闭幂等。

参考实现：[`src/channels/cli.ts`](../src/channels/cli.ts)、[`src/channels/telegram.ts`](../src/channels/telegram.ts)。

## 命令与菜单

命令清单在 [`src/config.ts`](../src/config.ts) 的 `COMMANDS`，它是解析、错拼建议和 Telegram 菜单的唯一来源。新增命令需要同时改：

1. `CommandKind` 类型。
2. `COMMANDS` 数组（命令名、中文别名、描述、是否进菜单）。
3. `TAKES_BODY`（只有需要参数的命令才加）。
4. `Router.handle` 的分支。
5. 测试：`tests/router.test.ts` 的解析用例和对应行为用例。

中文别名只参与精确匹配；错拼建议只针对 `menu: true` 的英文命令。

## 常见错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| `eventId` 用随机数或时间 | 同一事件重复建任务 | 用业务主键，格式固定 |
| Source 里直接写数据库或建任务 | 绕过鉴权、去重和状态机 | 只构造 `IncomingMessage` 并 `enqueue` |
| 忘记 `stop()` 定时器 | 进程关闭被拖住 | 在关闭流程中先停 Source |
| 适配器返回增量文本 | 摘要重复、回执变长 | 只在完整消息时返回 `text` |
| 适配器用 shell 语法 | 参数被当成普通字符串 | `buildArgs` 每次只表达一个参数 |
| 注册表名称与配置不一致 | 启动报未知适配器 | 两处使用同一个字符串 |
| 测试里跑真实 `gh`/网络 | 测试不稳定、产生副作用 | 注入 runner 或假 transport |
| 默认开启新来源 | 升级后立刻产生任务 | 默认 `enabled: false` |

## 完成标准

- 新代码有对应测试，且只跑定向测试就能验证。
- `bun test` 与 `bunx tsc --noEmit` 通过。
- 配置示例、README 或部署文档同步更新。
- 不修改 Router 的状态机语义；确实需要时先补规格，再改代码。
