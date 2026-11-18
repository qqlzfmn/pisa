# 扩展指南

加事件来源、加执行器、加通道的操作手册。契约原文在 [architecture.md](./architecture.md#4-扩展点)，术语在 [domain.md](./domain.md)，部署与排障在 [deployment.md](./deployment.md)。

## 扩展点总览

| 想扩展 | 契约 | 落点 | 装配点 |
| --- | --- | --- | --- |
| 新的 HTTP 事件协议 | `TriggerAdapter`（`src/triggers/types.ts`） | `src/triggers/<name>.ts` | `src/triggers/http.ts` 的 `routes.set` |
| 常驻事件来源（轮询、文件、定时） | 无统一接口，直接产出 `IncomingMessage` | `src/triggers/<name>.ts` 或 `src/<name>.ts` | `src/index.ts` 构造并 `start()` |
| 新的执行器 | `WorkerAdapter`（`src/adapters/types.ts`） | `src/adapters/<name>.ts` | `src/adapters/index.ts` 的 `REGISTRY` |
| 新的会话通道 | `ChannelAdapter`（`src/types.ts`） | `src/channels/<name>.ts` | `src/index.ts` 显式分支 |

所有扩展都遵循同一分工：适配器只做「翻译」，去重、权限、状态机、账本都在 core。翻译层不写数据库、不发消息。

## 加一个事件来源

以 GitLab Issue Webhook 为例。整个过程分六步，每步都有对应测试。

### 1. 定配置类型

在 `src/config.ts` 加触发配置，挂进 `TriggersConfig`。密钥只存环境变量名，不存值：

```ts
export interface GitlabTriggerConfig {
  enabled: boolean;
  /** 密钥所在的环境变量名，例如 PISA_GITLAB_SECRET */
  secretEnv: string;
  /** 允许的仓库路径；空数组表示不限制 */
  projects?: string[];
}

export interface TriggersConfig {
  // …既有字段
  gitlab?: GitlabTriggerConfig;
}
```

同步 `pisa.config.example.json` 的 `triggers` 段，并在 [operations.md](./operations.md) 的触发适配器一节加一段说明。

### 2. 写适配器

新建 `src/triggers/gitlab.ts`。三个方法各有唯一落点：`verify` 验签与解析，`normalize` 白名单与消息字段，`dedupeKey` 跨重启稳定去重键。

```ts
import { commandText, TriggerError, type HttpTriggerRequest, type TriggerAdapter, type TriggerOutcome } from "./types";

interface GitlabIssuePayload {
  project: { path_with_namespace: string };
  object_attributes: { iid: number; title: string; url: string };
}

export interface GitlabAdapterOptions {
  config: { secretEnv: string; projects?: readonly string[] };
  secret: string;
  trigger: string;
  chatId: string;
  userId: string;
}

export class GitlabAdapter implements TriggerAdapter<HttpTriggerRequest, GitlabIssuePayload> {
  readonly name = "gitlab";

  constructor(private readonly opts: GitlabAdapterOptions) {}

  async verify(raw: HttpTriggerRequest): Promise<GitlabIssuePayload> {
    if (raw.method !== "POST") throw new TriggerError(405, "只接受 POST");
    if (!this.opts.secret) throw new TriggerError(503, "triggers.gitlab 已启用，但密钥未配置");
    if (raw.headers.get("x-gitlab-token") !== this.opts.secret) throw new TriggerError(401, "签名不匹配");
    try {
      return JSON.parse(raw.body || "{}") as GitlabIssuePayload;
    } catch {
      throw new TriggerError(400, "正文不是合法 JSON");
    }
  }

  normalize(payload: GitlabIssuePayload): TriggerOutcome | null {
    const project = payload?.project?.path_with_namespace;
    const iid = payload?.object_attributes?.iid;
    if (!project || !iid) return null;
    const allow = this.opts.config.projects ?? [];
    if (allow.length > 0 && !allow.includes(project)) throw new TriggerError(403, "仓库不在白名单");
    return {
      event: {
        dedupeKey: this.dedupeKey(payload),
        message: {
          eventId: this.dedupeKey(payload),
          channel: "gitlab",
          chatId: this.opts.chatId,
          userId: this.opts.userId,
          text: commandText(this.opts.trigger, `Issue ${project}#${iid}：${payload.object_attributes.title}\n${payload.object_attributes.url}`),
          threadKey: `gitlab:${project}:issue:${iid}`,
          messageKey: `gitlab:${project}:issue:${iid}`,
          actor: this.opts.userId,
        },
      },
    };
  }

  dedupeKey(payload: GitlabIssuePayload): string {
    const project = payload.project.path_with_namespace;
    const iid = payload.object_attributes.iid;
    return `gitlab:${project}:issue:${iid}`;
  }
}
```

硬性约定：

- `dedupeKey` 必须带 `<source>:` 命名空间，且只由外部事件标识构成，不能含时间戳、随机数、进程内计数
- `eventId` 直接用 `dedupeKey`；core 会把它再写进触发器表去重
- `threadKey` 表示「同一件事」，`messageKey` 表示「哪条消息」；评论类事件用评论 id 当 `messageKey`
- `version` 只在同一消息会更新时给（编辑时间），内容没变时 core 会忽略
- 返回 `null` 表示这次事件不处理（心跳、非目标事件类型），不要为了「看起来收到」返回空消息
- 拒绝用 `TriggerError(status, message)`，状态码原样回给对端

### 3. 装配到 HTTP 路由

在 `src/triggers/http.ts` 的 `makeTriggersHandler` 里注册。未启用就不注册，路径自然 404；启用但缺 `chatId`/`userId` 在装配时直接抛错：

```ts
if (cfg.gitlab?.enabled) {
  requireIdentity("gitlab");
  routes.set(
    "/gitlab/event",
    new GitlabAdapter({
      config: cfg.gitlab,
      secret: env[cfg.gitlab.secretEnv] ?? "",
      trigger: deps.cfg.trigger,
      chatId,
      userId,
    }),
  );
}
```

再从 `src/triggers/index.ts` 导出类与类型（测试与外部装配要用），并把新路径记进下面的路由表。三条路由共用一个监听 `127.0.0.1` 端口，`http.port` 缺省 8790。

### 触发路由

| 路径 | 适配器 | 启用条件 | 鉴权 |
| --- | --- | --- | --- |
| `/github/actions` | `GithubActionsAdapter` | `triggers.githubActions.enabled` | `x-hub-signature-256` HMAC，密钥取 `secretEnv` |
| `/feishu/event` | `FeishuAdapter` | `triggers.feishu.enabled` | `x-lark-signature`，密钥取 `secretEnv` |
| `/wecom/event` | `WecomAdapter` | `triggers.wecom.enabled` | `msg_signature` + AES 解密，token/aesKey 取 `tokenEnv`/`aesKeyEnv` |

未注册的路径返回 404；`GET` 请求正文为空仍走验签，通常被适配器以 405 拒绝。

### 4. 常驻来源（不走 HTTP）

轮询、文件监听、定时这类来源不需要适配器，直接构造 `IncomingMessage` 交给 `router.handle`。参照 `src/triggers/file-watch.ts`、`src/scheduler.ts`、`src/proactive.ts`：

- 构造函数收 `{ cfg, store, enqueue }`，`enqueue` 就是 `(m) => router.handle(m)`
- 自己维护 `start()` / `stop()`，`src/index.ts` 里构造、启动、关停各一行
- 去重仍靠 `eventId` 前缀命名空间（如 `file-watch:`）；进程内不能靠 Map 去重，重启就丢
- 失败只影响自己：捕获异常、记日志、下一轮继续，不能让主循环退出

### 5. 测试

测试放 `tests/trigger-adapters.test.ts`，与现有适配器同一套工具：`makeTriggersHandler` 直接打 `Request`，`record(messages)` 收集消息，真实 `Store` 验去重。最小覆盖四件事：

```ts
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { makeTriggersHandler } from "../src/triggers";
import type { IncomingMessage } from "../src/types";

const ENV = { PISA_GITLAB_SECRET: "s3cret" };
const NOW = 1_700_000_000_000;
const ISSUE = { project: { path_with_namespace: "acme/web" }, object_attributes: { iid: 7, title: "修复登录页", url: "https://gitlab.com/acme/web/-/issues/7" } };

const cfg = {
  trigger: "/pisa",
  whitelist: { users: [], repos: [] },
  repos: [],
  triggers: { chatId: "c1", userId: "u1", gitlab: { enabled: true, secretEnv: "PISA_GITLAB_SECRET", projects: ["acme/web"] } },
} as unknown as Config;

function request(body: unknown, token = "s3cret"): Request {
  return new Request("http://127.0.0.1:8790/gitlab/event", {
    method: "POST",
    headers: { "content-type": "application/json", "x-gitlab-token": token },
    body: JSON.stringify(body),
  });
}

describe("GitLab 适配器", () => {
  const seen: IncomingMessage[] = [];
  const handler = makeTriggersHandler({ cfg, handle: async (m) => void seen.push(m), env: ENV, now: () => NOW });

  test("Issue 事件归一成带触发词的任务消息", async () => {
    seen.length = 0;
    const res = await handler(request(ISSUE));
    expect(res.status).toBe(200);
    expect(seen[0]?.channel).toBe("gitlab");
    expect(seen[0]?.text.startsWith("/pisa ")).toBe(true);
    expect(seen[0]?.threadKey).toBe("gitlab:acme/web:issue:7");
  });

  test("同一条 Issue 重投得到同一个去重键", async () => {
    seen.length = 0;
    await handler(request(ISSUE));
    await handler(request(ISSUE));
    expect(new Set(seen.map((m) => m.eventId)).size).toBe(1);
  });

  test("签名不符拒绝，且不投递", async () => {
    seen.length = 0;
    expect((await handler(request(ISSUE, "wrong"))).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test("缺密钥时启用入口返回 503", async () => {
    const bare = makeTriggersHandler({ cfg, handle: async () => {}, env: {}, now: () => NOW });
    expect((await bare(request(ISSUE))).status).toBe(503);
  });
});
```

`eventId` 相同只证明适配器稳定；真正落库去重用 `store.createTaskFromTrigger`（参照同文件 `persist(store)` 的写法）再断言任务表只有一行。仓库/用户白名单、装配期缺 `chatId`/`userId` 抛错也按同文件既有用例补齐。

### 6. 同步文档与示例

提交前逐项勾选：

- [ ] `pisa.config.example.json` 有 `triggers.gitlab` 示例
- [ ] `docs/operations.md` 触发适配器一节有配置与鉴权说明
- [ ] `docs/architecture.md` §4.2 的适配器表加了新来源
- [ ] 本文件的「触发路由」表加了新路径
- [ ] `CHANGELOG.md` 的「新增」写了新来源

验证：

```bash
bun test tests/trigger-adapters.test.ts
bunx tsc --noEmit
```

## 加一个 Worker 适配器

Worker 适配器把任务翻译成一条命令行和一个提示词，再把 agent 的 stdout 行翻译成给人看的文本。

### 1. 实现接口

新建 `src/adapters/<name>.ts`，实现 `WorkerAdapter`：

```ts
import { buildPrompt } from "./index";
import type { AdapterInput, ParsedLine, WorkerAdapter } from "./types";

export class MyAgentAdapter implements WorkerAdapter {
  readonly name = "myagent";

  buildArgs(input: AdapterInput): string[] {
    const prompt = buildPrompt(input.task, { resume: Boolean(input.resume) });
    return [
      input.cfg.command,
      ...input.cfg.extraArgs,
      ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
      "--cwd", input.workdir,
      "-p", prompt,
    ];
  }

  buildEnv(input: AdapterInput): Record<string, string> {
    return { PISA_WORKDIR: input.workdir, PISA_PROGRESS_FILE: input.progressFile };
  }

  parseLine(line: string): ParsedLine {
    const text = line.trim();
    if (!text) return {};
    try {
      const event = JSON.parse(text) as { type?: string; text?: string };
      return event.type === "message" && event.text ? { text: event.text } : { raw: text };
    } catch {
      return { raw: text };
    }
  }
}
```

硬性约定：

- 只用 `input.workdir` 作为工作目录，不要自己 `cd`；命令必须非交互运行，stdin 由 pisa 关掉
- 提示词统一用 `buildPrompt`，它含恢复段的核对要求；自己拼会丢掉这条约束
- `buildEnv` 只返回新增变量；父进程环境已按 `worker.envAllow` 白名单过滤，不要再整份透传
- `parseLine` 返回的是展示文本：`text` 进聊天与日志，`raw` 用于失败时的尾部摘要。不要在这里做去重或状态判断
- 会话恢复不是必需的：`resumeSessionId` 有值才传；不支持的 agent 直接忽略即可，任务仍会重跑

### 2. 注册

`src/adapters/index.ts` 的 `REGISTRY` 加一行，默认仍是 `omp`：

```ts
const REGISTRY: Record<string, () => WorkerAdapter> = {
  omp: () => new OmpAdapter(),
  myagent: () => new MyAgentAdapter(),
};
```

未注册的名字由 `getAdapter` 直接抛错，错误消息会列出可用项，不需要另写校验。

### 3. 选择

```bash
cat > pisa.config.json <<JSON
{
  "repos": [{ "alias": "demo", "path": "$PWD" }],
  "worker": { "adapter": "myagent", "command": "myagent" }
}
JSON
```

`worker.adapter` 选实现，`worker.command` 是可执行文件名；`extraArgs` 会插在命令后、适配器参数前。`timeoutSec`、`idleTimeoutSec`、`concurrency`、`envAllow` 与适配器无关，全部生效。

### Worker 适配器清单

| 名字 | 实现 | 会话恢复 | 备注 |
| --- | --- | --- | --- |
| `omp` | `src/adapters/omp.ts` | 支持（`-r <会话 id>`） | 默认；配套 `extensions/pisa-worker.ts` 负责命令拦截与进度上报 |

本表由 `tests/docs-cookbook.test.ts` 对照 `REGISTRY` 校验，加适配器必须同步改这里。

### 4. 测试

测试放 `tests/adapter.test.ts`，直接断言三段输出，不启动子进程：

```ts
import { expect, test } from "bun:test";
import { getAdapter } from "../src/adapters";

test("myagent 组装参数与环境", () => {
  const adapter = getAdapter("myagent");
  expect(adapter.name).toBe("myagent");
  const args = adapter.buildArgs({
    task: { id: "t_20260101_abcdef", prompt: "修一下登录页", repo: "demo" } as never,
    workdir: "/tmp/wt",
    extensionPath: "/tmp/ext.ts",
    progressFile: "/tmp/progress.jsonl",
    cfg: { adapter: "myagent", command: "myagent", timeoutSec: 60, extraArgs: [], concurrency: 1 },
  });
  expect(args).toContain("--cwd");
  expect(args.at(-2)).toBe("-p");
  expect(adapter.parseLine('{"type":"message","text":"改了 2 个文件"}')).toEqual({ text: "改了 2 个文件" });
  expect(adapter.parseLine("plain output")).toEqual({ raw: "plain output" });
});
```

再补一条「未注册名字抛错」的用例，确保 `getAdapter("不存在")` 的信息包含可用列表。

### 5. 能力边界

- 命令拦截（禁止 `git push`、`rm -rf` 等）目前由 `extensions/pisa-worker.ts` 的 omp 扩展实现。换适配器后这层不生效，只剩 pisa 自己的 git 与交付兜底
- 会话 id 不在适配器里产出：它由 Worker 扩展写进进度流的 `{"type":"session","sessionId":…}` 行，`router` 落库。新 agent 要支持恢复，需要自己的钩子写同样一行
- 退出码与结果解析在 `src/worker.ts`，适配器只提供命令行与文本翻译；不要让 `parseLine` 吞掉错误行

验证：

```bash
bun test tests/adapter.test.ts
bunx tsc --noEmit
```
