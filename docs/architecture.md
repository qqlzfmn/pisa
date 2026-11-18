# pisa 架构

面向两类读者：要改内核的贡献者，和半年后回来读代码的自己。内容只回答五个问题——层怎么分、任务怎么流转、数据怎么走、哪里能插东西、哪里会坏。

代码是唯一事实源；本文给位置和约束，不复述实现。规格细节见 `docs/specs/`（尤其 001 状态机、003 事件入口、005 恢复语义、013 撤销）。

## 1. 分层与职责

五层，依赖只能向下：

```
┌──────────────── web（外部世界）─────────────────────────────┐
│ Telegram Bot API   GitHub（gh CLI：评论/PR）   HTTP /event   stdin/stdout │
└──────────────▲─────────────────────────────────▲────────────┘
               │ 入站事件                          │ 出站文本
┌──────────────┴─────────────────────────────────┴────────────┐
│ cli：装配与进程生命周期                                        │
│   src/index.ts（唯一的 composition root）                     │
│   src/channels/{cli,telegram}.ts（通道适配器）                 │
│   scripts/supervise.sh（外部重启回路）                         │
└──────────────▲─────────────────────────────────▲────────────┘
               │ IncomingMessage                   │ channel.send()
┌──────────────┴─────────────────────────────────┴────────────┐
│ core：编排（全部状态与决策）                                    │
│   router / store / worker / deliver / git / github /          │
│   github-watcher / proactive / scheduler / rewind /           │
│   config / types / log / adapters                             │
└──────────────▲─────────────────────────────────▼────────────┘
               │ WorkerResult                      │ 提示词 + 进程参数
┌──────────────┴─────────────────────────────────┴────────────┐
│ runtime：执行者                                                │
│   .pisa/worktrees/<taskId>（git worktree）                     │
│   agent 进程（omp，cwd 指向工作副本）                            │
│   .pisa/logs、.pisa/progress、agent 自有会话存储                 │
│   └─ skill：extensions/pisa-worker.ts（挂在 agent 进程内）      │
└──────────────────────────────────────────────────────────────┘
```

| 层 | 代码 | 职责 | 明确不做 |
| --- | --- | --- | --- |
| web | 外部系统 | 提供事件；承接回执 | 不做判定，不碰数据库 |
| cli | `src/index.ts`、`src/channels/`、`src/cli.ts`、`src/api.ts`、`src/api-client.ts`、`scripts/supervise.sh` | 读配置、装配依赖、启动/停止、信号与退出码；管理接口与 `pisa` 命令 | 不含任务语义，不写业务状态 |
| core | `src/` 其余文件 | 唯一的状态机与调度中心：去重、鉴权、排队、编排、交付、记账、恢复 | 不直接执行任务动作：不调模型、不改业务文件 |
| runtime | worktree + agent 进程 | 真正改代码、跑测试、产出提交 | 不直接对用户说话，不改任务状态 |
| skill | `extensions/pisa-worker.ts` | 在 agent 进程内采集进度、拦截危险命令 | 只写 progress jsonl，不反向调用 core |

两条硬边界：

- **core 不认识具体通道，也不认识具体 agent**。通道走 `ChannelAdapter` 接口（`src/types.ts`），agent 走 `WorkerAdapter` 接口（`src/adapters/types.ts`），装配只发生在 `src/index.ts`。
- **CLI 不读数据库**：`pisa` 只读 `pisa.config.json` 与 `<stateDir>/api.json`，全部读写走 `127.0.0.1` 的管理接口；接口鉴权只看 `api.json` 里的随机令牌。
- **core 与 runtime 之间只有两个接口**：`WorkerRunner.run()` 进（`src/worker.ts`），文件与 git 出（`src/git.ts`、`src/deliver.ts`）。skill 通过 progress jsonl 单向上报，core 轮询读取，没有回调。

core 内部模块关系：

| 模块 | 职责 | 主要对外接口 |
| --- | --- | --- |
| `router.ts` | 全局唯一编排者：事件入口、命令、状态跃迁、进度转发、回帖；管理动作（建单/重试/停止/合并/撤销）也在这里，IM 与 HTTP 共用 | `handle()`、`start()/stop()`、`recoverInterrupted()`、`createTicket`、`stopTicket`、`mergeTicket`、`rewindTicket` |
| `management.ts` | 管理接口的领域类型与视图：`TaskView`、`StateView`、`api.json` 读写、`ManagementError` | `stateView()`、`taskView()`、`writeApiInfo()` |
| `api.ts` / `api-client.ts` | HTTP 壳与 CLI 客户端：只做鉴权、路由、JSON 编解码与退出码映射 | `startApi()`、`ApiClient` |
| `store.ts` | SQLite 持久化：任务、消息映射、事件去重、副作用账本 | `insertTask`、`claimQueued`、`transition`、`taskByPr`、`effectsOf` |
| `worker.ts` | 拉起 agent 进程、解析输出、超时与取消 | `class Worker implements WorkerRunner` |
| `adapters/` | 把 pisa 的任务翻译成某个 agent 的命令行与输出格式 | `getAdapter(name)` |
| `deliver.ts` | 提交 → 推送 → 开 PR，失败不留半成品状态 | `GitDeliverer.deliver()` |
| `git.ts` | worktree、分支、提交、推送的封装 | `sh()` 之上的命令封装；`merge`、`rev-parse` 这类一次性命令在 `router.ts` 里直接调 `sh` |
| `github.ts` | 所有 `gh` 调用与回帖去重标记 | 测试可注入 `Runner` |
| `github-watcher.ts` | 轮询 GitHub 评论，把命中触发词的评论转成事件 | 构造时注入 `enqueue` |
| `scheduler.ts` | cron 到点开单 | 构造时注入 `enqueue` |
| `proactive.ts` | 群聊关键词与定时探针 | 构造时注入 `enqueue` |
| `rewind.ts` | 撤销计划与执行（纯逻辑 + 探测接口注入） | `planRewind`、`applyRewind` |
| `log.ts` / `config.ts` / `types.ts` | 日志脱敏、配置加载与默认值、共享类型与状态机表 | — |

## 2. 任务状态机与恢复语义

```
queued    ──claimQueued─────────► running
queued    ──cancel──────────────► cancelled
running   ──交付成功────────────► succeeded
running   ──失败/超时/异常──────► failed
running   ──cancel──────────────► cancelled
running   ──重启且可续跑────────► paused
paused    ──resume──────────────► running
paused    ──cancel──────────────► cancelled
succeeded ─┐
failed    ─┼──rewind────────────► rewound
cancelled ─┘
```

上图的边与 `ALLOWED` 一一对应：`queued` 两条出边、`running` 四条、`paused` 两条、三个终态各一条 `rewound`。

合法跃迁表定义在 `src/types.ts` 的 `ALLOWED`，由 `canTransition` 与 `store.transition` 共同守护：

| 从 | 到 | 触发者 | 入口 |
| --- | --- | --- | --- |
| — | `queued` | 鉴权通过后的新事件 | `store.insertTask`（`src/router.ts`） |
| `queued` | `running` | 调度器认领 | `store.claimQueued`（`src/router.ts`），原子 UPDATE，失败即放弃 |
| `queued` | `cancelled` | 请求者 `cancel` | `handleCancel`（`src/router.ts`） |
| `running` | `paused` | 重启时工作副本与 agent 会话都在 | `recoverInterrupted`（`src/router.ts`） |
| `running` | `succeeded` | 交付完成 | `runTask`（`src/router.ts`） |
| `running` | `failed` | Worker 非零退出、超时、异常、交付抛错、启动失败 | `runTask`（`src/router.ts`） |
| `running` | `cancelled` | 请求者 `cancel`，Worker 退出后落地 | `handleCancel` 与 `runTask`（`src/router.ts`） |
| `paused` | `running` | 请求者 `resume`（人工，不自动） | `handleResume`（`src/router.ts`） |
| `paused` | `cancelled` | 请求者 `cancel` | `handleCancel`（`src/router.ts`） |
| `succeeded`/`failed`/`cancelled` | `rewound` | 请求者 `rewind --yes`，执行完且合并状态可确认 | `handleRewind`（`src/router.ts`） |

不变量：

- 所有跃迁都是 compare-and-set：`UPDATE … WHERE id=? AND status=<旧值>`，并发认领或重复操作只有一个成功。
- `queued → running` 只能经 `claimQueued`（在 SQL 里写 `startedAt` 与分支名）；其余跃迁经 `transition`。
- 终态只有 `rewound` 这一条出边，运行态无法回退；撤销完的任务不能再 resume。
- 状态写入只有三个来源：事件驱动的 `runTask`、重启时的 `recoverInterrupted`、请求者发起的 `cancel`/`resume`/`rewind`。关停路径刻意不写状态。

恢复语义（对应 005）：

| 场景 | 判定依据 | 归宿 | 依据 |
| --- | --- | --- | --- |
| 进程在任务执行中退出 | 重启时 `status='running'` | agent 会话 id 与 `.pisa/worktrees/<id>` 都存在 → `paused` | `recoverInterrupted`（`src/router.ts`） |
| 同上，缺一样 | — | `failed`，error=`进程重启，任务中断` | 会话或工作副本已无法续跑 |
| 主动关停（SIGINT/SIGTERM） | `stopping` 标志 | 任务保持 `running`，不落 failed/succeeded，不删 worktree 与分支 | `router.stop()` 最多等 3 秒；`src/index.ts` 退出码 75 交给 supervisor |
| 重启后遗留 `queued` | — | 由 `fill()` 继续认领，自动执行 | 队列在数据库里，不在内存里 |
| 重启后 `paused` | — | 保持，等 `resume` 或 `cancel`（`rewind` 要求先取消） | 人工决定，避免自动重跑产生第二个 PR |
| 停机期间到达的事件 | — | 丢失（内存队列为空，事件不落盘等待） | 只有已 `insertTask` 的任务会恢复 |

`resume` 的字段语义：`baseRef` 指上一轮分支（worktree 从这里拉出）；`context` 是注入提示词的上一轮摘要；`branch`/`prUrl` 在 PR 评论续跑时指向父任务的同一分支与同一 PR，避免同一需求出现两个 PR。

## 3. 一次任务的完整数据流

```
触发源 → IncomingMessage → Router.handle → 落库(queued) → 回执
        → fill(800ms) → claimQueued → runTask
        → createWorktree → Worker.run(omp 进程) ⇄ progress jsonl
        → deliver(commit → push → PR) → 记账 → succeeded
        → dropWorktree → replyToSource → 最终回执
```

逐步（括号内是代码位置）：

1. **事件进入**。五类触发源都产生 `IncomingMessage`，`eventId` 是唯一键：
   - IM：`channel.start(onMessage)` 回调里先喂 `Proactive.observe`，再 `router.handle`（`src/index.ts`）。
   - webhook：`Bun.serve` 只接 127.0.0.1 的 `POST /event`，校验 `x-pisa-token`，body `{prompt, repo?, eventId?}`，缺省 `eventId` 为 `webhook:<ts>:<rand>`（`src/index.ts`）。
   - GitHub 评论：`GithubWatcher` 每 `intervalSec`（默认 120s）按仓库轮询 `gh api …/issues/comments?since=`，命中触发词的评论转成事件；PR 评论带 `continueFrom`（按 `taskByPr` 找父任务）与 `replyPr`，Issue 评论带 `replyIssue`。
   - 管理接口：`POST /tickets`（`src/api.ts`）解析后直接调 `Router.createTicket`，与 IM 建单共用校验、事件去重与 `insertTask`，任务 `channel="api"`，回执发往配置里的 IM 会话。
   - cron 与主动发现：`Scheduler` 每 30s 扫一次表达式，`Proactive` 观察群聊关键词或跑探针，命中就 `enqueue`。
2. **归一化与路由**（`Router.handle`，`src/router.ts`）。顺序固定：`@别名` 提取仓库 → 回复消息映射到父任务并改写为 `continue` → 命令解析（`config.ts` 的 `COMMANDS`）→ 待确认态 → 拼写校验 → 命令分支 → 建任务。
3. **去重与鉴权**（`claimEvent` 与 `checkAccess`，`src/router.ts`）。`newId()` 先出任务号，`store.claimEvent(eventId, taskId)` 用主键抢占事件，抢不到直接丢弃；随后 `checkAccess` 校验白名单用户、白名单仓库、目录是 git 仓库。被拒事件同样占用 `eventId`。
4. **落库与回执**（`Router.handle`，`src/router.ts`）。`insertTask`（`status=queued`）后立刻回 `已接单 · <任务号>`，再把 `chatId+messageId → taskId` 写入 `task_messages`，后续回复该消息即可续跑。
5. **调度**（`fill` 与 `launch`，`src/router.ts`）。`start(800)` 定时 `fill()`：执行器暂停（`POST /executor/pause`，持久化在 `meta`）时不领取新任务；活跃数小于 `worker.concurrency`（默认 2）时取最早 `queued` 任务，`claimQueued` 成功才 `launch`，分支名默认 `pisa/<taskId>`。
6. **工作副本**（`runTask`，`src/router.ts`）。`resuming` 用工作副本是否存在判断；新建时 `git worktree add -b <branch> <workdir> <baseRef|baseBranch|HEAD>`，随后记两条副作用（`worktree`、`branch`；共用父分支时 `detail="shared"`），回 `开始执行`，启动进度转发。
7. **执行**（`Worker.run`，`src/worker.ts`）。`adapter.buildArgs` 生成命令行（omp：`-e <extension> [-r <sessionId>] --mode=json -p <prompt> --cwd <workdir>`），`Bun.spawn` 的 cwd 就是工作副本，环境变量附带 `PISA_WORKDIR`、`PISA_PROGRESS_FILE`。超时按 `worker.timeoutSec`（默认 3600s）`SIGTERM`，10s 后 `SIGKILL`；取消每 2s 轮询一次，同样先礼后兵。stdout 按行交给 `adapter.parseLine`，最终 `summary` 与 `error` 都过 `redact`。
8. **进度回传**。skill 把 `session`/`tool`/`blocked`/`done` 追加进 `.pisa/progress/<taskId>.jsonl`；`watchProgress`（`src/router.ts`）每 2s 读增量，节流 6s，转成 `🛠`/`✏️`/`⛔` 消息发到原对话。progress 只是旁路，丢了不影响任务结果。
9. **交付**（`GitDeliverer.deliver`，`src/deliver.ts`）。`git status --porcelain` 无改动直接返回；有改动则 `commitAll`（`pisa: <首行>`，正文带任务号）→ 若 `delivery.push` 且配置了远程则 `push -u origin <branch>`（失败即抛错，任务落 `failed`）→ 若 `delivery.pr`、远程在 github.com、`gh` 可用则 `gh pr create`（PR 正文带 `Closes #<issue>`），否则退回 `compare` 链接。成功后记 `push`/`pr` 副作用。
10. **收尾**。`transition(succeeded)` 写入 `summary/branch/prUrl/endedAt` → 删工作副本（保留分支与副作用账本）→ `replyToSource` 回 PR/Issue（正文带隐藏标记 `<!-- pisa:reply task=… -->`，重启重跑也不会重复回帖）→ 最终回执（摘要、文件清单、分支、链接、会话 id）。

一次成功任务落盘的东西：

| 位置 | 内容 | 何时删除 |
| --- | --- | --- |
| `pisa.db` `tasks` | 任务全字段 | 永不 |
| `pisa.db` `task_messages` | 信道消息 → 任务 | 永不 |
| `pisa.db` `events` | 事件去重键 | 永不 |
| `pisa.db` `task_effects` | 仍在生效的分支/推送/PR/回帖/合并 | 撤销或清理时逐条删 |
| `.pisa/api.json` | 管理接口端口与令牌（0600） | 守护进程退出时删除 |
| `.pisa/logs/<taskId>.log` | 阶段日志（脱敏） | 不自动清理 |
| `.pisa/progress/<taskId>.jsonl` | 工具级进度 | 不自动清理 |
| `.pisa/worktrees/<taskId>` | 工作副本 | 成功、失败、运行中取消后删除；`paused` 及其后续取消保留 |
| git 分支 `pisa/<taskId>` | 改动 | 交付前失败/取消时删；成功后保留 |

四类变体：`continue`（IM 续跑原任务，分支与上下文来自父任务）、PR 评论（`taskByPr` 找到父任务，复用同一分支与 PR）、`resume`（`paused` 且工作副本在，同一 worktree + agent `-r` 会话续跑）、`rewind`（终态任务先出计划，`--yes` 再执行，成功项删账本行，失败项留着重试）。

## 4. 扩展点

### 4.1 WorkerAdapter：换 agent

接口在 `src/adapters/types.ts`：

```ts
interface WorkerAdapter {
  name: string;
  buildArgs(input: AdapterInput): string[];
  buildEnv(input: AdapterInput): Record<string, string>;
  parseLine(line: string): ParsedLine;
}
```

`AdapterInput` 给 `task`、`workdir`、`extensionPath`、`progressFile`、`cfg`（`worker.*`）、`resumeSessionId`。registry 在 `src/adapters/index.ts`，目前只有 `omp`。

接入一个新 agent 需要满足的契约：

1. 命令行里能指定工作目录（pisa 不 `cd`，只设 `spawn.cwd`）。
2. stdout 逐行可解析；`parseLine` 只返回「值得展示给人」的文本，其余返回 `{raw}` 留给错误摘要。
3. 支持一次性的非交互执行；有会话续跑能力时用 `resumeSessionId`，没有就忽略（任务仍能跑，只是 `paused` 无法续跑）。
4. 环境变量至少透传 `PISA_WORKDIR`；`PISA_PROGRESS_FILE` 只有在 agent 侧也有对应 skill 时才有意义。
5. 退出码约定：0 成功，非 0 失败且最后若干行 stdout/stderr 会进 `error`。

策略拦截没有做成适配器的一部分：它依赖 agent 的事件钩子（omp 的 pi 扩展）。换成不提供钩子的 agent 时，拦截会一起消失，`delivery` 与 `git.ts` 里的命令仍然是最后一道限制。

### 4.2 Trigger：加事件源

契约只有一条：产出 `IncomingMessage` 并调用 `router.handle`，`eventId` 必须稳定（同一物理事件重复投递得到同一个字符串）。内置五种触发源都按这个模式接：

| 触发源 | 代码 | eventId 形态 | 稳定性来源 |
| --- | --- | --- | --- |
| IM | 通道 → `handle` | cli：`cli:<ts>:<rand>`；telegram：`telegram:<chatId>:<messageId>` | cli 一次投递一次；telegram 靠消息 id 幂等 |
| webhook | `src/index.ts` | `webhook:<ts>:<rand>`，可由调用方覆盖 | 调用方提供即可重放去重 |
| GitHub 评论 | `github-watcher.ts` | `github:comment:<repo>:<commentId>` | 评论 id，天然幂等 |
| cron | `scheduler.ts` | `cron:<jobId>:<minuteKey>`，先 `cron-claim:<jobId>:<minuteKey>` 抢占 | 分钟键，同一分钟只投一次 |
| 主动发现 | `proactive.ts` | `proactive:kw:<ts>` / `proactive:probe:<ts>` | 一次机会一次事件 |

新增触发源三步：写一个类，构造参数收 `enqueue`（需要配置或存储的再加 `cfg`、`store`）；在 `src/index.ts` 里实例化并 `start()`；在 `shutdown()` 里 `stop()`。不需要改 `router.ts`。冷却与去重这类「触发源自己的节流」放在触发源内部（例如 `Proactive` 的 cooldown、`GithubWatcher` 的 `since` 下界），core 只负责事件级去重。

### 4.3 入口客户端：加通道

`ChannelAdapter`（`src/types.ts`）：

```ts
interface ChannelAdapter {
  name: string;
  start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void>;
  send(chatId: string, text: string): Promise<DeliveryReceipt | void>;
  stop(): Promise<void>;
  setCommands?(commands: { command: string; description: string }[]): Promise<void>;
}
```

`send` 返回的 `messageId` 会写进 `task_messages`，这是「回复某条消息即续跑」的数据基础；不返回就没有该能力。通道选择在 `src/index.ts` 是显式分支（`--channel cli`、`telegram.enabled`、`channels.cli`），没有 registry：新增通道要改装配代码。这是目前唯一与适配器不对称的地方，代价是 `index.ts` 里多一个分支，收益是启动路径一眼可读。

### 4.4 其它可注入点

- `Deliverer`（`src/deliver.ts`）：替掉交付策略（例如先开草稿 PR、走内部镜像）。
- `RouterDeps.ghRunner` 与 `DelivererDeps.createPr/hasGh`：测试替换 `gh`，生产不联网。
- `RewindProbes`（`src/rewind.ts`）：撤销计划只依赖探测接口，测试用假探测验证分支/PR 各状态组合。
- `now()`：时间注入，测试里控制冷却与超时。

## 5. 失败模式与已知限制

### 5.1 失败模式

| 失败点 | 检测方式 | 任务归宿 | 副作用处理 | 恢复路径 |
| --- | --- | --- | --- | --- |
| 非白名单 / 非 git 仓库 | `checkAccess` | 不建任务 | 事件键已占用 | 改配置后换 eventId 重投 |
| 工作副本创建失败（分支被占用） | `createWorktree` 报 `already checked out` | `failed` | 无 | 先 `cancel` 占用它的任务 |
| Worker 非零退出 | 退出码 + 最后 20 行 | `failed` | 删 worktree 与 `pisa/<id>` 分支 | 重新投递 |
| 执行超时 | `worker.timeoutSec` | `failed`（`执行超时`） | 同上 | 拆小任务 |
| 请求者取消 | 每 2s 轮询 `cancelRequested`；`queued`/`paused` 直接改状态 | `cancelled` | `running`：删 worktree 与 `pisa/<id>` 分支；`queued`/`paused`：worktree（若有）保留 | — |
| 推送失败 | `pushBranch` 抛错 | `failed` | worktree 删除后本地提交一并消失，远程无残留 | 修远程/凭据后重投 |
| PR 创建失败 | `gh pr create` 无输出 | 任务仍 `succeeded` | 分支已推 | 手动开 PR，或按回执里的 compare 链接 |
| 回帖失败 | 抓异常写日志 | 不影响状态 | 无 | 手动补，标记保证不重复 |
| 进程被杀 | `recoverInterrupted` | `paused` 或 `failed` | worktree 保留（paused） | `resume` 或 `rewind` |
| 重复投递 | `claimEvent` 主键冲突 | 只有一条任务 | — | 自动 |
| 交付过程抛任意异常 | `runTask` catch | `failed` | 删 worktree 与分支 | 重新投递 |

失败一律有可见原因：`error` 写库并出现在最终回执里，不允许静默消失（001 的目标项）。

### 5.2 已知限制

1. **无沙箱**。agent 进程以当前用户身份运行，继承全部环境变量，能读写工作副本之外的文件。`extensions/pisa-worker.ts` 的拦截是按 bash 命令文本首段匹配的正则 denylist（`git push`、`git reset --hard`、带 `f` 的 `git clean`、`rm -rf /`（`/tmp` 除外）、`sudo`、改 `/etc` 的 `chmod/chown`），`/usr/bin/git push`、`git -c … push`、脚本包装、非 bash 工具写文件都不在覆盖范围。worktree 只隔离同一仓库的分支，不是文件系统隔离。
2. **单机**。SQLite、worktree、日志、agent 会话都在本机 `.pisa` 与 agent 自己的存储里。`supervise.sh` 在本机按 1→30s 退避重启，机器下线即系统下线；没有跨机器接管。
3. **并发**。上限是 `worker.concurrency`（默认 2），以进程内活跃 Promise 计；多任务共享同一 `.git` 对象库，交付只 `git add -A` 自己的工作副本；同一分支不能有两个 worktree，续跑同一分支的第二个任务会直接失败；`merge` 要求主工作区停在 base 分支。
4. **信号只到直接子进程**：超时与取消对 agent 进程 `SIGTERM`→`SIGKILL`，它派生的孙进程可能残留。
5. **去重先于鉴权**：`claimEvent`（`src/router.ts`）在 `checkAccess` 之前，被拒或被参数校验拦下的事件也占用了 `eventId`，同一 id 不会重试。
6. **内存态丢失**：24h 拒绝提示节流、单字确认的 10 分钟待确认态、主动发现冷却、`GithubWatcher.since`（启动时设为进程启动时刻）都在内存。重启后去重窗口归零，停机期间发布的评论不会被补拉。
7. **调度不补跑**：cron 粒度到分钟、tick 30s，停机错过的时间窗不补；同一分钟只投一次。
8. **`gh pr create` 未在生产验证**（README「当前状态」）：没配远程的仓库只得到 compare 链接。
9. **撤销有边界**：只覆盖记账的副作用（分支、推送、PR、回帖、工作副本、合并）。已发出的评论不可撤回；PR 状态无法确认时保留分支且不标 `rewound`；只允许原请求者操作，运行中的任务要求先取消。
10. **终态不可回运行态**：`rewound` 之后只能重新投递一条新任务。

## 6. 与 dsh-superagent 的取舍

对照对象是 DeepSeek Harness 团队的《Super-agent 设计探索：迈向更自主的 Agent 系统》（2026-10-31）与开源原型 `dsh-superagent-prototype`；pisa 的架构来源见 README「致谢」。

| 维度 | dsh-superagent | pisa | 取舍理由 |
| --- | --- | --- | --- |
| Router 实现 | 常驻 LLM 会话，负责语义判断、分派、全局记忆，不挂 Bash | 确定性状态机（`router.ts`），全程不调模型 | 判定条件可枚举（白名单、触发词、命令），不需要推理；省掉一次模型往返与不可预测性 |
| 事件过滤 | 两级：程序层 Fast Path 准入 + LLM 语义 Slow Path | 单级程序过滤（触发词、白名单、关键词、探针退出码） | 单机单人场景噪音可控；语义过滤要额外成本与延迟，收益不足 |
| 事件路由 | Thread 订阅直通 Worker，Router 只看未订阅事件；去掉直通后 Router 决策数 +30%、token +37% | 事件级去重 + `chatId+messageId → taskId` 映射，回复即续跑；所有事件仍经 `handle` | 直通省的是 Router 的模型 token，pisa 的 Router 不花 token；保留统一入口换来实现简单、状态集中 |
| 上下文组织 | Inline & Spill + 链式召回，把上下文窗口当 cache，对象间靠 id 图按需展开 | 分支续跑 + 显式注入上一轮请求/结果/分支摘要 | 会话与工作目录都随任务清理，恢复会话必然失败（003 已记录）；代码状态比对话状态更可靠 |
| 并发 | 每任务一个 Worker 会话，Router 层内可再分片 | 进程级并发上限 2，每任务一个 worktree，同层任务互不通信 | 共享仓库的写冲突用独立 worktree 解决；Worker 间通信在单人场景没有消费者 |
| 持久 | 云端无状态计算 + 数据库存会话状态；端侧只放无状态 daemon（BYOM） | 单机 SQLite + 本地 worktree + supervisor 重启 | 目标是「一台常驻机器上的个人系统」，分布式带来的状态迁移与安全成本大于收益 |
| 自愈 | 外部 Watchdog 会话，由模型判断 Worker 是否真有进展/偏航 | `supervise.sh` 按退出码退避重启 + 启动时遗留任务分流 + 任务级超时 | 退出码与超时是确定信号，覆盖了 pisa 当前绝大部分故障；「进展是否有效」暂不做判断 |
| 主动 | 两级过滤 + 投机执行（后台先做，有价值才交付） | 群聊关键词 + 定时探针，命中即开单 | 投机执行需要「先做再判断价值」，成本与判废机制都还没建 |
| 交互 | 按信道定制（IM ≤100 词、GitHub 结构化），异步 ReAct Loop 全双工 | 固定回执格式（接单/开始/完成/失败），进度按 6s 节流推送；入口只接收「投递」与「命令」，不做需求澄清 | 人类与 agent 不共享循环：agent 在独立进程里跑完一轮，Router 只处理消息 |
| 安全 | 明确列为开放问题：云端被攻陷则端侧全失守，凭据进上下文即风险 | 正则 denylist + 白名单 + 无沙箱（限制同 5.2 第 1 条） | 单人可信环境下的最小成本方案；接入多人前必须先解决 |

共同点：双层拆分（接单与执行分离）、Worker 不直接对外说话、状态与执行分离、主动触发、外部重启回路。分歧集中在**用不用模型做控制面**：dsh 把 Router 也交给模型，pisa 把 Router 做成普通的持久化状态机。

什么时候应该往 dsh 的形态演进（三条触发条件，任一成立）：

1. 入口事件量或种类导致确定性过滤漏判/误判（例如需要在「像请求，但其实是讨论」之间判断）——加语义 Slow Path。
2. 需要跨机器在线，或需要把执行环境留在用户设备上——拆「计算/状态/环境」，先外置会话状态。
3. 需要在故障时判断「任务是否还有进展」而不仅是「进程是否活着」——把 supervisor 换成能读进度与日志的独立控制回路。

## 索引

| 想改什么 | 先读 |
| --- | --- |
| 任务状态与恢复 | `src/types.ts`、`src/store.ts`、`docs/specs/005-crash-resume/` |
| 事件入口 | `src/router.ts` 的 `handle`、`src/index.ts`、`docs/specs/003-super-agent-loop/` |
| 换 agent | `src/adapters/`、`src/worker.ts` |
| 交付与 PR | `src/deliver.ts`、`src/git.ts`、`src/github.ts` |
| 撤销 | `src/rewind.ts`、`docs/specs/013-rewind/` |
| 配置项 | `src/config.ts`、`pisa.config.example.json` |
