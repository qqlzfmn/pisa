# 扩展指南：加来源与加适配器

两类扩展的方向相反：

- 加**来源（Source）**：多一个入口把事件推进来。只写一个类 + 在 `src/index.ts` 装配，不动 core 与路由。
- 加**适配器（Adapter）**：多支持一种 agent CLI。只写一个类 + 在注册表登记，不动执行流程。

契约的完整定义在 [architecture.md](./architecture.md) 的「4. 扩展点」；术语见 [domain.md](./domain.md)；装与排障见 [deployment.md](./deployment.md)。

## 一、加一个来源

来源要做的事只有一件：把外部事件整理成 `IncomingMessage` 交给 `enqueue`。去重、鉴权、排队、交付都在 core 里，来源不要重复实现。

### 步骤 1：确定身份字段

身份错了，去重和续跑都会错。先回答四个问题，再写代码：

| 字段 | 怎么定 | 定错的后果 |
| --- | --- | --- |
| `channel` | 入口名，和别的来源不重名 | 不同来源的事件互相覆盖线程 |
| `threadKey` | 同一件事的后续消息共用的键；工单 id、PR 号、频道 + 会话 id | 不填则回落到被回复的任务，再回落到 `channel:chatId:eventId`，于是每条消息都成独立任务，回复续跑断链 |
| `messageKey` | 线程内稳定且唯一的消息 id，优先用平台 id（评论 id、消息 id） | 不填时取 `eventId`；如果 `eventId` 每次投递都变，重放会产生重复任务 |
| `version` | 消息的编辑时间等；没有版本概念就不填 | 编辑后的消息会被当成新消息，只留痕不重跑 |

`actor` 填真实发起人：转发链路里投递身份可能是机器人，评论场景要取评论作者。

### 步骤 2：写类

新建 `src/mysource.ts`。构造参数自己定，但必须接一个 `enqueue`；`start()` 起监听，`stop()` 解绑并关连接。

```ts
import type { IncomingMessage } from "./types";

export class MySource {
  constructor(
    private cfg: { chatId: string; userId: string },
    private enqueue: (m: IncomingMessage) => Promise<void>,
  ) {}

  /** 事件到手后只做整理，不做去重、不做鉴权 */
  async handle(event: { id: string; path: string; body: string; updatedAt?: string }): Promise<void> {
    await this.enqueue({
      eventId: `mysource:${event.id}`,
      channel: "mysource",
      chatId: this.cfg.chatId,
      userId: this.cfg.userId,
      text: event.body,
      isDirect: true,
      threadKey: `mysource:${event.path}`,
      messageKey: event.id,
      version: event.updatedAt,
    });
  }

  start(): void {
    // 注册 webhook、开轮询、订阅队列……
  }

  stop(): void {
    // 解绑监听、关连接；重复调用要安全
  }
}
```

验证：

```bash
bunx tsc --noEmit
```

### 步骤 3：在 `src/index.ts` 装配

装配点集中在 `router.start()` 附近，入口都走 `router.handle`：

```ts
const mysource = new MySource({ chatId: "my", userId: "mysource" }, (m) => router.handle(m));
router.start();
mysource.start();
```

关停块里按相反顺序停：

```ts
mysource.stop();
```

拿不到 `router` 的入口（例如独立进程）不要绕开它直接写库：走 HTTP（`webhook.enabled`）或 CLI。

验证：起进程后手工触发一次事件，能查到新任务且 source 是填的 `channel`：

```bash
bun run src/index.ts --channel cli
bun run src/cli.ts list
```

### 步骤 4：加配置

两个文件同时改，缺一个就会出现「配置写了但没生效」或「示例配置校验失败」：

- `src/config.ts`：`Config` 类型加字段，`DEFAULT_CONFIG` 与 `merge()` 给默认值。
- `pisa.config.example.json`：补同名段，值用占位符。

配置里的开关缺省为关；启动日志负责说明「启用/未启用」，不要静默生效。

验证：全量测试通过，且缺配置时行为与默认值一致：

```bash
bun test
```

### 步骤 5：写测试

新建 `tests/mysource.test.ts`，用假 `enqueue` 断言身份，不依赖网络：

```ts
import { expect, test } from "bun:test";
import { MySource } from "../src/mysource";
import type { IncomingMessage } from "../src/types";

test("同一条事件重复投递给出同一身份", async () => {
  const seen: IncomingMessage[] = [];
  const source = new MySource({ chatId: "c", userId: "u" }, async (m) => {
    seen.push(m);
  });
  const event = { id: "42", path: "docs/a.md", body: "修一下" };
  await source.handle(event);
  await source.handle(event);

  expect(seen[0]!.eventId).toBe(seen[1]!.eventId);
  expect(seen[1]).toMatchObject({ channel: "mysource", threadKey: "mysource:docs/a.md", messageKey: "42" });
});
```

如果来源有节流、游标一类跨重启的状态，存到 `store.meta`，测试里用同一个 store 复现「重启后不重复推送」，而不是放进程内变量。

验证：

```bash
bun test tests/mysource.test.ts
bunx tsc --noEmit
```

### 检查表

- 改动的文件只有：新来源类、`src/index.ts`、`src/config.ts`、`pisa.config.example.json`、新测试。
- 没有改 `src/router.ts`；去重靠身份字段，不靠来源自己记表。
- `stop()` 幂等，关停时不会卡住 `router.stop()` 的 3 秒窗口。

## 二、加一个适配器

适配器把 core 的「跑一个任务」翻译成某个 agent CLI 的命令行。执行、超时、卡死、取消、交付都不归它管。

### 步骤 1：读清契约

```ts
export interface WorkerAdapter {
  name: string;
  buildArgs(input: AdapterInput): string[];
  buildEnv(input: AdapterInput): Record<string, string>;
  parseLine(line: string): ParsedLine;
}
```

| 方法 | 必须做到 | 做不到的后果 |
| --- | --- | --- |
| `buildArgs` | 非交互执行、工作目录用 `input.workdir`、续跑时带上 `input.resumeSessionId` | agent 等输入导致卡死；任务跑在错误的目录 |
| `buildEnv` | 至少给 `PISA_WORKDIR` 与 `PISA_PROGRESS_FILE`，并在 CLI 支持时加载 pisa 的扩展 | 进度丢失、守卫不生效、无法 `resume` |
| `parseLine` | 只返回要展示给用户的助手文本；其余行用 `raw` 保留 | 摘要里混进工具噪声，或摘要为空 |

已有实现：

| worker.adapter | 实现 |
| --- | --- |
| `omp` | `OmpAdapter`（`src/adapters/omp.ts`） |

### 步骤 2：写类

新建 `src/adapters/myagent.ts`。尽量复用 `buildPrompt`，它已包含任务正文、上一轮上下文、恢复段与守卫约束：

```ts
import { buildPrompt } from "./omp";
import type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";

export class MyAgentAdapter implements WorkerAdapter {
  name = "myagent";

  buildArgs({ cfg, workdir, task, resume, resumeSessionId }: AdapterInput): string[] {
    return [
      cfg.command,
      ...cfg.extraArgs,
      "--cwd",
      workdir,
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
      "-p",
      buildPrompt(task, { resume }),
    ];
  }

  buildEnv({ workdir, progressFile }: AdapterInput): Record<string, string> {
    return { PISA_WORKDIR: workdir, PISA_PROGRESS_FILE: progressFile };
  }

  parseLine(line: string): ParsedLine {
    const clean = line.trim();
    return clean ? { raw: clean } : {};
  }
}
```

`buildEnv` 只返回追加项，PATH、HOME 等由 core 的 `worker.envAllow` 白名单统一给出。

验证：类型检查通过；`parseLine` 对空行返回 `{}`，对普通文本返回原文。

```bash
bunx tsc --noEmit
```

### 步骤 3：登记注册表

改 `src/adapters/index.ts` 的 `REGISTRY`：

```ts
const REGISTRY: Record<string, () => WorkerAdapter> = {
  omp: () => new OmpAdapter(),
  myagent: () => new MyAgentAdapter(),
};
```

`ADAPTERS` 由注册表派生，无需另改；未登记的名字会在 `getAdapter` 里报「未知的 Worker 适配器」并列出可用项。

验证：换适配器后 CLI 正常：

```bash
bun run src/cli.ts status
```

### 步骤 4：切配置

`worker.adapter` 选实现，`worker.command` 选可执行文件；两者独立，便于同一 CLI 的不同安装路径：

```json
{ "worker": { "adapter": "myagent", "command": "/usr/local/bin/myagent" } }
```

验证：起进程后提交一个小任务，能拿到摘要：

```bash
bun run src/index.ts --channel cli
```

### 步骤 5：写测试

在 `tests/adapter.test.ts` 里复用已有的 `input` 固定装置，追加用例：

```ts
import { expect, test } from "bun:test";
import { getAdapter } from "../src/adapters";

test("myagent：参数带工作目录与会话续跑", () => {
  const adapter = getAdapter("myagent");
  const args = adapter.buildArgs({ ...input, resume: true, resumeSessionId: "s1" });
  expect(args).toContain("--cwd");
  expect(args.join(" ")).toContain("--resume s1");
  expect(adapter.parseLine("hello")).toEqual({ raw: "hello" });
});
```

验证：

```bash
bun test tests/adapter.test.ts
bunx tsc --noEmit
```

### 检查表

- 改动的文件只有：新适配器、`src/adapters/index.ts`、测试；`src/worker.ts` 不动。
- 不把提示词、超时、取消写进适配器；它们属于 core。
- 续跑能在 CLI 上验证：同一会话第二次启动带 `-r` / `--resume` 等价参数。

### 没有扩展钩子的 CLI 会损失什么

`buildEnv` 只给两个环境变量时，agent 侧没有任何 pisa 代码，下面这些能力随之消失（architecture 4.1 已列契约）：

- 守卫：`blockBash` / `outsideWorkdir` 不生效，危险命令与越界路径只能靠沙箱兜底。
- 进度：只剩 stdout 的静默判定，卡死检测从 900 秒变成「多久没输出」。
- 会话：拿不到 `sessionId` 就没有 `resume`，中断只能重跑。
