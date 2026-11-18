# pisa 架构

面向两类读者：要改内核的贡献者，和半年后回来读代码的自己。内容只回答五个问题——层怎么分、任务怎么流转、数据怎么走、哪里能插东西、哪里会坏。

代码是唯一事实源；本文给位置和约束，不复述实现。规格细节见 `docs/specs/`（尤其 001 状态机、003 事件入口、005 恢复语义、013 撤销）。

## 1. 分层与职责

五层，依赖只能向下：

```
┌──────────────── web（外部世界）─────────────────────────────┐
│ Telegram Bot API   GitHub（gh CLI：评论/PR）   HTTP /event · /ui   stdin/stdout │
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
│   router / store / worker / deliver / effects / git /         │
│   github / github-watcher / proactive / scheduler / rewind /  │
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
| cli | `src/index.ts`、`src/channels/`、`scripts/supervise.sh` | 读配置、装配依赖、启动/停止、信号与退出码 | 不含任务语义，不写业务状态 |
| core | `src/` 其余文件 | 唯一的状态机与调度中心：去重、鉴权、排队、编排、交付、记账、恢复 | 不直接执行任务动作：不调模型、不改业务文件 |
| runtime | worktree + agent 进程 | 真正改代码、跑测试、产出提交 | 不直接对用户说话，不改任务状态 |
| skill | `extensions/pisa-worker.ts` | 在 agent 进程内采集进度、拦截危险命令 | 只写 progress jsonl，不反向调用 core |

两条硬边界：

- **core 不认识具体通道，也不认识具体 agent**。通道走 `ChannelAdapter` 接口（`src/types.ts`），agent 走 `WorkerAdapter` 接口（`src/adapters/types.ts`），装配只发生在 `src/index.ts`。
- **core 与 runtime 之间只有两个接口**：`WorkerRunner.run()` 进（`src/worker.ts`），文件与 git 出（`src/git.ts`、`src/deliver.ts`）。skill 通过 progress jsonl 单向上报，core 轮询读取，没有回调。

core 内部模块关系：

| 模块 | 职责 | 主要对外接口 |
| --- | --- | --- |
| `router.ts` | 全局唯一编排者：事件入口、命令、状态跃迁、进度转发、回帖 | `handle()`、`start()/stop()`、`recoverInterrupted()` |
| `store.ts` | SQLite 持久化：任务、消息映射、事件去重、副作用账本、外部动作队列 | `insertTask`、`claimQueued`、`transition`、`taskByPr`、`effectsOf`、`enqueueEffect`、`dueEffects` |
| `worker.ts` | 拉起 agent 进程、解析输出、超时与取消 | `class Worker implements WorkerRunner` |
| `adapters/` | 把 pisa 的任务翻译成某个 agent 的命令行与输出格式 | `getAdapter(name)` |
| `deliver.ts` | 提交 → 推送 → 开 PR；推送与建 PR 交给 outbox 执行 | `GitDeliverer.deliver()`、`effectHandlers()` |
| `effects.ts` | 外部动作 outbox：先落库再执行，按 `(kind,key)` 去重，失败指数退避，重启后重放 | `EffectQueue.exec()`、`start()/stop()`、`cancelTask()` |
| `git.ts` | worktree、分支、提交、推送的封装 | `sh()` 之上的命令封装；`merge`、`rev-parse` 这类一次性命令在 `router.ts` 里直接调 `sh` |
| `github.ts` | 所有 `gh` 调用与回帖去重标记 | 测试可注入 `Runner` |
| `github-watcher.ts` | 轮询 GitHub 评论与 open PR，把命中触发词的评论、未评审的 PR 版本转成事件 | 构造时注入 `enqueue` |
| `pr-review.ts` | 评审线程键、事件键与提示词（纯函数） | `reviewThreadKey`、`reviewEventId`、`buildReviewPrompt` |
| `scheduler.ts` | cron 到点开单 | 构造时注入 `enqueue` |
| `proactive.ts` | 群聊关键词与定时探针 | 构造时注入 `enqueue` |
| `rewind.ts` | 撤销计划与执行（纯逻辑 + 探测接口注入） | `planRewind`、`applyRewind` |
| `reconcile.ts` | 资源对账：任务记录与分支/工作副本/PR 的差异（纯计划 + 执行） | `planReconcile`、`applyReconcile`、`formatReconcile` |
| `stage.ts` / `status.ts` | 任务阶段规则表与对外投影：阶段、JSON 字段、看板文本 | `taskStage()`、`taskJson()`、`formatStatusBoard()` |
| `metrics.ts` | 指标聚合：24h 汇总与按小时历史（成功率、耗时分位、队列/运行采样）；看板、CLI、`/health` 与 `/api/metrics` 共用 | `computeWindowMetrics()`、`windowMetrics()`、`metricHistory()`、`percentile()` |
| `web.ts` / `web-ui.ts` | 本机控制台：HTTP 外壳 + 单页；写操作转成 `IncomingMessage` 交给 `router.handle`，不复制鉴权与状态机；配置编辑复用 `config-edit.ts`，撤销复用 `Router.rewindPreview/rewindExecute` | `createWebApp()`、`startWebServer()`、`ReplyBus` |
| `config-edit.ts` | 配置的可编辑投影、保存前校验与原子写回；保存后需重启生效 | `editableConfig()`、`validateConfigPatch()`、`saveConfigPatch()` |
| `audit.ts` | 写操作审计：`<stateDir>/audit.log` 追加 JSONL，超 1MiB 轮转一代 | `AuditLog` |
| `log.ts` / `config.ts` / `types.ts` | 日志脱敏、配置加载与默认值、共享类型与状态机表 | — |

## 2. 任务状态机与恢复语义

```
queued    ──claimQueued─────────► running
queued    ──cancel──────────────► cancelled
running   ──交付成功────────────► succeeded
running   ──失败/超时/异常──────► failed
running   ──cancel──────────────► cancelled
running   ──重启且已请求取消────► cancelled
running   ──重启且可续跑────────► paused
paused    ──resume──────────────► running
paused    ──cancel──────────────► cancelled
succeeded ─┐
failed    ─┼──rewind────────────► rewound
cancelled ─┘
```

上图的边与 `ALLOWED` 一一对应：`queued` 两条出边、`running` 五条、`paused` 两条、三个终态各一条 `rewound`。

合法跃迁表定义在 `src/types.ts` 的 `ALLOWED`，由 `canTransition` 与 `store.transition` 共同守护：

| 从 | 到 | 触发者 | 入口 |
| --- | --- | --- | --- |
| — | `queued` | 鉴权通过后的新事件 | `store.insertTask`（`src/router.ts`） |
| `queued` | `running` | 调度器认领 | `store.claimQueued`（`src/router.ts`），原子 UPDATE，失败即放弃 |
| `queued` | `cancelled` | 请求者 `cancel` | `handleCancel`（`src/router.ts`） |
| `running` | `paused` | 重启时工作副本与 agent 会话都在 | `recoverInterrupted`（`src/router.ts`） |
| `running` | `succeeded` | 交付完成 | `runTask`（`src/router.ts`） |
| `running` | `failed` | Worker 非零退出、超时、异常、交付抛错、启动失败 | `runTask`（`src/router.ts`） |
| `running` | `cancelled` | 请求者 `cancel`，Worker 退出后落地；或重启时 `cancel_requested` 已置位 | `handleCancel`、`runTask` 与 `recoverInterrupted`（`src/router.ts`） |
| `paused` | `running` | 请求者 `resume`（人工，不自动） | `handleResume`（`src/router.ts`） |
| `paused` | `cancelled` | 请求者 `cancel` | `handleCancel`（`src/router.ts`） |
| `succeeded`/`failed`/`cancelled` | `rewound` | 请求者 `rewind --yes`，执行完且合并状态可确认 | `handleRewind`（`src/router.ts`） |

不变量：

- 阶段不是状态：`src/stage.ts` 由 `status`、`branch`、`prUrl` 只读派生，不写库、不参与 `ALLOWED`，因此新增阶段不会改变状态机或恢复语义。
- 所有跃迁都是 compare-and-set：`UPDATE … WHERE id=? AND status=<旧值>`，并发认领或重复操作只有一个成功。
- `queued → running` 只能经 `claimQueued`（在 SQL 里写 `startedAt` 与分支名）；其余跃迁经 `transition`。
- 终态只有 `rewound` 这一条出边，运行态无法回退；撤销完的任务不能再 resume。
- 状态写入只有三个来源：事件驱动的 `runTask`、重启时的 `recoverInterrupted`、请求者发起的 `cancel`/`resume`/`rewind`。关停路径刻意不写状态。
- 对外的写动作（推送、建 PR、回帖）只经 `EffectQueue.exec`：先按 `(kind,key)` 写 `effects` 行再执行，同一个键至多执行一次；失败留行退避重试（2s 起翻倍、60s 封顶、最多 10 次），进程重启后继续。

恢复语义（对应 005）：

| 场景 | 判定依据 | 归宿 | 依据 |
| --- | --- | --- | --- |
| 进程在任务执行中退出，且已请求取消 | 重启时 `status='running'` 且 `cancel_requested=1` | `cancelled`，工作副本保留 | 取消是写操作的否决票，重启不得把它改成可 `resume` 的 `paused`（`recoverInterrupted`） |
| 进程在任务执行中退出 | 重启时 `status='running'` | agent 会话 id 与 `.pisa/worktrees/<id>` 都存在 → `paused` | `recoverInterrupted`（`src/router.ts`） |
| 同上，缺一样 | — | `failed`，error=`进程重启，任务中断` | 会话或工作副本已无法续跑 |
| 主动关停（SIGINT/SIGTERM） | `stopping` 标志 | 任务保持 `running`，不落 failed/succeeded，不删 worktree 与分支 | `router.stop()` 最多等 3 秒；`src/index.ts` 退出码 75 交给 supervisor |
| 重启后遗留 `queued` | — | 由 `fill()` 继续认领，自动执行 | 队列在数据库里，不在内存里 |
| 重启后 `paused` | — | 保持，等 `resume` 或 `cancel`（`rewind` 要求先取消） | 人工决定，避免自动重跑产生第二个 PR |
| 停机期间到达的事件 | — | 丢失（内存队列为空，事件不落盘等待） | 只有已 `insertTask` 的任务会恢复 |
| 重启时 `effects` 里仍有 `pending` 行 | — | 立即重放，之后每 1s 扫一次到期行 | 动作幂等：推送、按 head 认领 PR、回帖标记；`EffectQueue.start()` |

`resume` 的字段语义：`baseRef` 指上一轮分支（worktree 从这里拉出）；`context` 是注入提示词的上一轮摘要；`branch`/`prUrl` 在 PR 评论续跑时指向父任务的同一分支与同一 PR，避免同一需求出现两个 PR。

## 3. 一次任务的完整数据流

```
触发源 → IncomingMessage → Router.handle → 落库(queued) → 回执
        → fill(800ms) → claimQueued → runTask
        → createWorktree → Worker.run(omp 进程) ⇄ progress jsonl
        → deliver(commit → outbox: push → PR) → 记账 → succeeded
        → dropWorktree → replyToSource → 最终回执
```

逐步（括号内是代码位置）：

1. **事件进入**。所有触发源都产生 `IncomingMessage`；入口能给出更稳定的身份就填 `threadKey` / `messageKey` / `version` / `actor`，缺省由 core 补齐（见 4.2）：
   - IM：`channel.start(onMessage)` 回调里先喂 `Proactive.observe`，再 `router.handle`（`src/index.ts`）。
   - webhook：`Bun.serve` 只接 127.0.0.1 的 `POST /event`（`src/webhook.ts`），先做 token 常量时间比较（403）、`Content-Length` 与正文 64 KiB 上限（413），再校验 body `{prompt, repo?, eventId?, threadKey?, version?}`；`eventId` 必须是 `webhook:` 前缀（`events` 表跨通道共享，`cron:`/`github:comment:`/`telegram:` 归各自入口，越界 400），缺省为 `webhook:<ts>:<rand>`。校验全过后才交给 `router.handle`，被拒的请求不解析正文、不占事件号；带上 `threadKey`（业务单号）就能和别的入口命中同一个任务。
   - 通用触发适配层：`src/triggers/` 下的 `TriggerAdapter` 把外部协议归一成 `IncomingMessage`，`/github/actions`、`/feishu/event`、`/wecom/event` 共用 127.0.0.1 上的一个端口（默认 8790），文件监听不走 HTTP。验签、白名单与去重键都在适配器内部，任务仍由 `router.handle` 建，回执走配置的 `triggers.chatId`（见 4.2）。
   - Web 控制台：`Bun.serve` 只接 127.0.0.1 的 `/ui` 与 `/api/*`，token 鉴权通过后把派活/取消/合并拼成 `IncomingMessage`（`admin: true`）交给 `router.handle`，回执经 `ReplyBus` 收集后回给页面（`src/web.ts`）。`admin` 让 Router 跳过单英文词误触防护与原请求者校验——浏览器里的操作由 token 直接认证，没有可回 `confirm` 的聊天。
   - GitHub 评论：`GithubWatcher` 每 `intervalSec`（默认 120s）按仓库轮询 `gh api …/issues/comments?since=`，命中触发词的评论转成事件；PR 评论带 `continueFrom`（按 `taskByPr` 找父任务）与 `replyPr`，Issue 评论带 `replyIssue`。各仓库的 `since` 游标落在 `meta` 表的 `github:since:<repo>`，整轮成功才推进；重启后从这里继续，停机期间发布的评论会被补拉（重复由触发身份去重，编辑按 `updated_at` 区分）。
   - PR 自动评审：`github.review.enabled` 打开时，同一轮再列一次 open PR，对 `(仓库, PR, head SHA)` 没有触发器记录的版本拉 `gh pr diff`，投递 `mode: "review"` 的只读任务；去重键落在 `triggers` 表，diff 拉取失败不建任务。
   - cron 与主动发现：`Scheduler` 每 30s 扫一次表达式，`Proactive` 观察群聊关键词或跑探针，命中就 `enqueue`。
2. **归一化与路由**（`Router.handle`，`src/router.ts`）。顺序固定：`@别名` 提取仓库 → 回复消息映射到父任务并改写为 `continue` → 线程解析（`threadKeyOf`：入口声明 > 被回复任务 > 本条消息）→ 命令解析（`config.ts` 的 `COMMANDS`）→ 待确认态 → 拼写校验 → 命令分支 → 建任务。
3. **去重与鉴权**（`src/trigger.ts`、`src/policy.ts` 与 `checkAccess`，`src/router.ts`）。先 `checkAccess` 校验白名单用户、白名单仓库、目录是 git 仓库，再按来源准入表（`policy.sources`：名单 × 是否 @ × accept）判定，最后校验需求：被拦下的消息不写触发器，改完配置重发同一条即可。准入结果与策略版本随任务落库；`resume` 前用同一张表按任务记录的来源与原发起人重判。通过后 `makeTrigger` 算出触发身份，`store.triggerByMessage(threadKey, messageKey)` 命中同一条消息时，同版本同载荷即重复投递直接丢弃，版本不同即编辑（见 4.2）。
4. **落库与回执**（`Router.handle`，`src/router.ts`）。`store.createTaskFromTrigger` 在同一事务里写触发器与任务（`status=queued`），立刻回 `已接单 · <任务号>`，再把 `chatId+messageId → taskId` 写入 `task_messages`，后续回复该消息即可续跑。
5. **调度**（`fill` 与 `launch`，`src/router.ts`）。`start(800)` 定时 `fill()`：活跃数小于 `worker.concurrency`（默认 2）时取最早 `queued` 任务，`claimQueued` 成功才 `launch`，分支名默认 `pisa/<taskId>`。评审任务（`mode=review`）不取分支，执行走临时目录，不建 worktree、不交付。
6. **工作副本**（`runTask`，`src/router.ts`）。`resuming` 用工作副本是否存在判断；新建时 `git worktree add -b <branch> <workdir> <baseRef|baseBranch|HEAD>`，随后记两条副作用（`worktree`、`branch`；共用父分支时 `detail="shared"`），回 `开始执行`，启动进度转发。
7. **执行**（`Worker.run`，`src/worker.ts`）。`adapter.buildArgs` 生成命令行（omp：`-e <extension> [-r <sessionId>] --mode=json -p <prompt> --cwd <workdir>`），`Bun.spawn` 的 cwd 就是工作副本，环境变量附带 `PISA_WORKDIR`、`PISA_PROGRESS_FILE`。超时按 `worker.timeoutSec`（默认 3600s）`SIGTERM`，10s 后 `SIGKILL`；取消每 2s 轮询一次，同样先礼后兵。stdout 按行交给 `adapter.parseLine`，最终 `summary` 与 `error` 都过 `redact`。
8. **进度回传**。skill 把 `session`/`tool`/`blocked`/`done` 追加进 `.pisa/progress/<taskId>.jsonl`；`watchProgress`（`src/router.ts`）每 2s 读增量，节流 6s，转成 `🛠`/`✏️`/`⛔` 消息发到原对话。progress 只是旁路，丢了不影响任务结果。
9. **交付**（`GitDeliverer.deliver`，`src/deliver.ts`）。`git status --porcelain` 无改动直接返回；有改动则 `commitAll`（`pisa: <首行>`，正文带任务号）：`git add -A` 后按路径分拣，`.github/workflows/**`、`.github/actions/**`、`.env*`、`*.pem`、`*.key`、`id_*`、`.npmrc`、`.netrc`、`**/secrets*` 命中即 `git reset` 剔出索引，不信任 `.gitignore`；全被拦下时不产生空提交，任务照常成功，回执追加「⚠️ 未提交的敏感路径」。推送与建 PR 都经 outbox（`src/effects.ts`）：先按 `(kind,key)` 落 `effects` 行再执行，`push` 失败抛错让任务落 `failed`，`pr` 失败留在队列里退避重试、本轮退回 `compare` 链接。若 `delivery.pr`、远程在 github.com、`gh` 可用，先 `gh pr list --head <branch>` 认领该分支上已有的开放 PR（上次建好却没来得及记账），没查到才 `gh pr create`（PR 正文带 `Closes #<issue>`）；两者都在仓库根目录执行，工作副本删掉后重试仍可用。成功后由 Router 记 `push`/`pr` 副作用并回填 `pr_url`。无改动且任务无 `prUrl` 时，若分支已在 origin 上同样先认领一次。
10. **收尾**。`transition(succeeded)` 写入 `summary/branch/prUrl/endedAt` → 删工作副本（保留分支与副作用账本）→ `replyToSource` 经 outbox 回 PR/Issue（正文带隐藏标记 `<!-- pisa:reply task=… -->`，线程里已有同标记即视为发过，退避重试也不会重复回帖）→ 最终回执（摘要、文件清单、分支、链接、会话 id）。任务失败或取消时清掉该任务未完成的 effect 行。

一次成功任务落盘的东西：

| 位置 | 内容 | 何时删除 |
| --- | --- | --- |
| `pisa.db` `tasks` | 任务全字段 | 永不 |
| `pisa.db` `task_messages` | 信道消息 → 任务 | 永不 |
| `pisa.db` `triggers` | 触发身份（线程 / 消息 / 版本 / 载荷）与归属任务 | 永不 |
| `pisa.db` `events` | 定时与保留任务的占位键 | 超出保留期的终态任务对应行 |
| `pisa.db` `task_effects` | 仍在生效的分支/推送/PR/回帖/合并 | 撤销或清理时逐条删 |
| `pisa.db` `effects` | 外部动作队列：推送、建 PR、回帖的待执行/已完成/已终止行 | 不自动清理；任务失败或取消时删该任务的未完成行 |
| `.pisa/logs/<taskId>.log` | 阶段日志（脱敏） | 不自动清理 |
| `.pisa/progress/<taskId>.jsonl` | 工具级进度 | 不自动清理 |
| `.pisa/worktrees/<taskId>` | 工作副本 | 成功、失败、运行中取消后删除；`paused`、重启时按取消请求置 `cancelled` 的任务及其后续取消保留 |
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

契约两条：产出 `IncomingMessage` 并调用 `router.handle`；同一件事在重复投递、跨入口转发、编辑后重新投递时都落到同一个任务。身份由 `src/trigger.ts` 算出：

```
id = hex(sha256(source, threadKey, messageKey, version, payloadHash))[:32]
```

- `source`：入口名（`msg.channel`）。
- `threadKey`：会话线程。入口能声明就声明（Telegram 论坛话题、GitHub Issue/PR、调用方的业务单号），否则 core 按「被回复的任务 → `task:<任务号>`」或「本条消息 → `<channel>:<chatId>:<eventId>`」成线程。
- `messageKey`：线程内的消息标识，缺省 `eventId`。评论 id、平台消息 id 比自造事件号稳定。
- `version`：消息版本（编辑时间等），没有版本概念时为空串。
- `payloadHash`：解析后的需求正文的摘要（CRLF 归一 + trim），因此 `/pisa X` 与裸 `X` 命中同一个指纹。

`triggers` 表（`src/store.ts`）记录 `id`、`source`、`thread_key`、`message_key`、`actor`、`at`、`payload_hash`、`version`、`kind`、`task_id`，覆盖下面四种情形：

| 情形 | 处理 |
| --- | --- |
| 同线程同消息、同版本同载荷 | 重复投递：丢弃，不新建任务 |
| 同线程同消息、版本或载荷不同 | 编辑：记 `kind=context` 留痕；任务仍排队则用新正文覆盖需求，已开跑只留痕 |
| 同线程不同消息、不带命令 | 并进该线程未结束任务（`queued`/`paused`）的上下文，不新建任务 |
| 同线程不同消息、带命令 | 新任务：同一会话里的第二次明确请求是另一件事 |

内置十种触发源都按这个模式接：

| 触发源 | 代码 | threadKey | messageKey / version |
| --- | --- | --- | --- |
| IM | 通道 → `handle` | telegram 论坛话题 `telegram:<chatId>:topic:<id>`，其余本条消息 | 平台消息 id / `edit_date` |
| webhook | `src/index.ts` | body 的 `threadKey`，缺省本条消息 | `eventId` / body 的 `version` |
| Web 控制台 | `src/web.ts` | 本次提交 | `web:<uuid>` |
| GitHub 评论 | `github-watcher.ts` | `github:<repo>:issue:<n>` | 评论 id / `updated_at` |
| PR 自动评审 | `github-watcher.ts` | `github:<repo>:pull:<n>:review` | head SHA / head SHA |
| cron | `scheduler.ts` | 本条消息 | 分钟键 |
| 主动发现 | `proactive.ts` | 本条消息 | 事件号 |
| GitHub Actions | `src/triggers/github-actions.ts` | `github-actions:<repo>:<branch>` | run id / `updated_at` |
| 飞书 | `src/triggers/feishu.ts` | `feishu:<chat_id>` | `message_id` |
| 企业微信 | `src/triggers/wecom.ts` | `wecom:<FromUserName>` | `MsgId`，事件消息回退发送者 + 时间 |
| 文件监听 | `src/triggers/file-watch.ts` | `file-watch:<监听路径>` | 变化路径 + 事件时刻 |

触发记录不随保留策略清理：它是「这件事已经做过」的唯一凭据，删掉会让重放复活成新任务。

新增触发源三步：写一个类，构造参数收 `enqueue`（需要配置或存储的再加 `cfg`、`store`）；在 `src/index.ts` 里实例化并 `start()`；在 `shutdown()` 里 `stop()`。不需要改 `router.ts`。

新协议走适配器，不直接写 `router.handle`。`TriggerAdapter`（`src/triggers/types.ts`）把入口逻辑拆成三段，各自只有一个落点：

```ts
interface TriggerAdapter<Raw, Payload> {
  readonly name: string;
  verify(raw: Raw): Promise<Payload>;                 // 验签、解析；失败抛 TriggerError
  normalize(payload: Payload): TriggerOutcome | null; // 白名单 + 归一；null 表示忽略
  dedupeKey(payload: Payload): string;                // 去重键，进 messageKey
}
```

`dispatch` 串起来只有一条线：`verify → normalize → messageKey ??= dedupeKey → handle`。`TriggerOutcome.reply` 承载协议级回执（飞书 challenge、企业微信 `success`），没有 `event` 就只回执、不建任务。接入新协议时实现这三段、在 `src/triggers/http.ts` 加一条路径、在 `triggers` 配置里加一个 `enabled` 与白名单即可，`router.ts` 与 core 不动。冷却与去重这类「触发源自己的节流」放在触发源内部（例如 `Proactive` 的 cooldown、`GithubWatcher` 的 `since` 下界，跨越重启的进度写进 `store` 的 `meta`），core 只负责按触发身份去重。

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
| 非白名单 / 非 git 仓库 | `checkAccess` | 不建任务 | 未写触发器 | 改配置后重发同一条 |
| 准入表拒绝（名单外 / 未 @ / 来源关闭） | `policy.decide` | 不建任务 | 未写触发器 | 改 `policy.sources` 后重发；`observe` 先观察 |
| 工作副本创建失败（分支被占用） | `createWorktree` 报 `already checked out` | `failed` | 无 | 先 `cancel` 占用它的任务 |
| Worker 非零退出 | 退出码 + 最后 20 行 | `failed` | 删 worktree 与 `pisa/<id>` 分支 | 重新投递 |
| 执行超时 | `worker.timeoutSec` | `failed`（`执行超时`） | 同上 | 拆小任务 |
| 卡死（长时间无输出/无进度） | 每 30s 看进度文件与 stdout，超过 `worker.idleTimeoutSec`（默认 900s） | `failed`（`卡死：…`） | 同上 | 重投；调大 `idleTimeoutSec` 或拆小任务 |
| 执行器丢失（进程被 kill，但服务没重启） | `reconcileOrphans` 每 5s 对账 `running` 行与进程内 active 表 | 有 session+worktree → `paused`；否则 `failed` | worktree 保留（paused） | `resume` 或重投 |
| 请求者取消 | 每 2s 轮询 `cancelRequested`；`queued`/`paused` 直接改状态；`running` 但没有执行器时立即结束 | `cancelled` | `running`：删 worktree 与 `pisa/<id>` 分支；`queued`/`paused`：worktree（若有）保留 | — |
| 推送失败 | `pushBranch` 抛错 | `failed` | effect 行随任务失败丢弃；worktree 删除后本地提交一并消失，远程无残留 | 修远程/凭据后重投 |
| PR 创建失败 | `gh pr create` 无输出 | 任务仍 `succeeded` | 分支已推，`effect` 行留库退避重试 | 重试成功自动回填 `pr_url` 与账本；期间回执给 compare 链接 |
| 回帖失败 | `gh` 退出码非 0 | 不影响状态 | `effect` 行留库退避重试 | 重试到发出去；隐藏标记保证重复执行也只发一条 |
| 进程被杀 | `recoverInterrupted` | `cancelled`（已请求取消）/ `paused` / `failed` | worktree 一律保留 | 已取消不可 `resume`；`paused` 可 `resume` 或 `rewind` |
| 重复投递 | `triggerByMessage` 命中同版本同载荷 | 只有一条任务 | — | 自动 |
| 编辑已开跑任务的消息 | 版本不同但任务非 `queued` | 原任务不变 | 留一条 `kind=context` 触发记录 | 需要改需求就重新投递 |
| 交付过程抛任意异常 | `runTask` catch | `failed` | 删 worktree 与分支 | 重新投递 |

失败一律有可见原因：`error` 写库并出现在最终回执里，不允许静默消失（001 的目标项）。

### 5.2 已知限制

1. **无沙箱**。agent 进程以当前用户身份运行，能读写工作副本之外的文件；环境变量只继承 `worker.envAllow` 白名单里的键（默认 `PATH`、`HOME`、`LANG`、`LC_ALL`、`TERM`、`TMPDIR`、`SHELL`、`USER`），其余不进子进程。`extensions/pisa-worker.ts` 的拦截是按 bash 命令文本首段匹配的正则 denylist（`git push`、`git reset --hard`、带 `f` 的 `git clean`、`rm -rf /`（`/tmp` 除外）、`sudo`、改 `/etc` 的 `chmod/chown`），`/usr/bin/git push`、`git -c … push`、脚本包装、非 bash 工具写文件都不在覆盖范围。worktree 只隔离同一仓库的分支，不是文件系统隔离。
2. **单机**。SQLite、worktree、日志、agent 会话都在本机 `.pisa` 与 agent 自己的存储里。`supervise.sh` 在本机按 1→30s 退避重启，机器下线即系统下线；没有跨机器接管。
3. **并发**。上限是 `worker.concurrency`（默认 2），以进程内活跃 Promise 计；多任务共享同一 `.git` 对象库，交付只 `git add -A` 自己的工作副本；同一分支不能有两个 worktree，续跑同一分支的第二个任务会直接失败；`merge` 要求主工作区停在 base 分支，并先 rebase 到最新主干（否则历史前进后快进必然失败）。
4. **信号只到直接子进程**：超时与取消对 agent 进程 `SIGTERM`→`SIGKILL`，它派生的孙进程可能残留。
5. **去重按触发身份**：鉴权与参数校验通过才写 `triggers`，同一触发身份只会有一个任务；载荷指纹取解析后的需求正文，同一条消息换入口包装（`/pisa X` 与裸 `X`）仍命中同一个触发。旧库升级时 `Store` 构造会按任务自身信息补齐触发器，重放旧事件不会重复建任务。
6. **内存态丢失**：24h 拒绝提示节流、单字确认的 10 分钟待确认态、主动发现冷却都在内存。重启后这些窗口归零（去重靠 `triggers` 表长期有效；GitHub 评论游标已落库，停机期间的评论会补拉）。
7. **调度不补跑**：cron 粒度到分钟、tick 30s，停机错过的时间窗不补；同一分钟只投一次。
8. **`gh pr create` 未在生产验证**（README「已知限制」）：没配远程的仓库只得到 compare 链接。
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
| 资源对账 | `src/reconcile.ts`、`docs/specs/019-reconcile/` |
| 配置项 | `src/config.ts`、`pisa.config.example.json` |
| 控制台配置编辑与写操作审计 | `src/config-edit.ts`、`src/audit.ts`、`docs/specs/021-web-console-phase2/` |
