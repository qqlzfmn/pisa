# 领域模型与术语

读代码前先看这一页：每个词给出定义、代码位置和它约束的行为。结构怎么分层见 [architecture.md](./architecture.md)，配置与运维见 [operations.md](./operations.md)，安装与排障见 [deployment.md](./deployment.md)，扩展步骤见 [extending.md](./extending.md)。

反引号里是代码符号，可以在仓库里直接搜到。

## 任务与状态

| 术语 | 含义 | 代码位置与约束 |
| --- | --- | --- |
| 任务 `Task` | 一条需求从入队到交付的完整记录 | `src/types.ts`；`tasks` 表一行，事件、触发器、账本都按任务号关联 |
| 任务号 | `t_<yyyyMMdd>_<6位十六进制>` | `src/ids.ts`；CLI、看板、`pisa/<任务号>` 分支都用它 |
| 状态 `status` | `queued` `running` `paused` `succeeded` `failed` `cancelled` `rewound` 七种 | `ALLOWED` 是跃迁的唯一事实源；跃迁表见 [architecture.md](./architecture.md#任务状态机) |
| `paused` 中断 | 进程重启时 `running` 任务转成它；工作副本与会话都还在才能恢复 | 只能由请求者 `resume <任务号>` 恢复或取消；`pisa wait` 遇到它返回 4 |
| `rewound` 撤销 | 终态任务被标记为已撤销；它产出的分支、PR、评论、工作副本按账本回滚 | 只能从 `succeeded`/`failed`/`cancelled` 进入，不可再迁出 |
| 续跑 `continue` | 在已完成任务的同一分支上开新任务，注入上一轮摘要 | 新任务记录 `baseRef` 与 `context`；失败或取消不清理共享分支 |
| 阶段 `stage` | 面向人的进度：`person/answer` `person/review` `working/queued` `working` `idle` | `src/stage.ts` 的 `STAGE_RULES` 按顺序取第一个命中项；`stageText()` 渲染成「阶段（标签）」 |
| 摘要与错误 | `summary` 成功后回帖/展示；`error` 失败原因 | 状态机之外只读；看板与 `pisa show` 直接展示 |

状态含义速查：

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| `queued` | 已入队，等并发槽位 | 等 Worker 空出来；`cancel` 可取消 |
| `running` | Worker 子进程在跑 | `pause`/`resume`、`cancel`；不处理就等它结束 |
| `paused` | 被中断，可恢复 | `resume` 继续，`cancel` 放弃 |
| `succeeded` | 完成，可能带分支/PR | `merge`、`rewind`、`continue` |
| `failed` | 失败，`error` 有原因 | 看日志、重投或 `rewind` |
| `cancelled` | 被取消 | 不可恢复，可 `rewind` 收拾残留 |
| `rewound` | 已撤销 | 无 |

## 触发与去重

| 术语 | 含义 | 代码位置与约束 |
| --- | --- | --- |
| 触发器 `Trigger` | 一次事件的规范化记录：来源、线程、消息键、载荷指纹 | `src/trigger.ts`；`makeTrigger()` 计算 id 与 `payloadHash` |
| 触发器类型 `kind` | `task`：首次投递，建任务；`context`：同线程的补充信息 | `triggers` 表；`context` 行不建任务，进 `task_messages` 供后续任务注入 |
| 线程 `threadKey` | 同一件事的会话键；缺省由 core 按「回复的任务」或「本条消息」生成 | 入口要显式给：Telegram 话题、GitHub Issue/PR、业务单号 |
| 消息键 `messageKey` | 线程内的消息标识，缺省等于 `eventId` | 评论 id、平台消息 id 比一次投递的 `eventId` 稳定，优先用它 |
| 版本 `version` | 同一消息的编辑时间等版本标记 | 同一任务内不同版本只留痕；内容未变直接忽略 |
| 载荷指纹 `payloadHash` | 去掉 CRLF、首尾空白后的内容摘要 | 同线程同消息同指纹视为重复投递 |
| 事件号 `eventId` | 单次投递的标识 | webhook 默认 `webhook:<时间戳>:<随机>`；CLI 默认 `cli:<uuid>`，`--event-id` 可固定 |
| 去重键 `dedupeKey` | 适配器给出的跨重启稳定键，带 `<source>:` 命名空间 | 作为 `eventId` 与缺省 `messageKey`；同一 CI 运行重投只建一个任务 |
| 命名空间 | 去重键与事件号的前缀 | 已用：`cli:` `webhook:` `github-actions:` `feishu:` `wecom:` `file-watch:`；新增来源必须自带前缀，避免跨入口撞号 |

## 入口与线程

| 术语 | 含义 | 代码位置与约束 |
| --- | --- | --- |
| 入口 `channel` | 消息从哪个通道来：`telegram` `cli` `web` `webhook` `github-actions` `feishu` `wecom` | 通道适配器契约见 `src/types.ts` 的 `ChannelAdapter`；装配在 `src/index.ts` |
| `source` 与 `channel` | `Task.source` 记入口种类，`Task.channel` 记会话通道 | 两者都存 `tasks` 行，展示与回帖路由各用其一，不要混用 |
| 会话 `chatId` | 回复发到哪里；CLI 用请求者名，Web 用 `web` | 白名单、定时任务、触发适配器都按它定位接收方 |
| 请求者 `userId` / `actor` | `userId` 是入口侧的账号；`actor` 是真实发起人 | PR 评论这类以配置身份投递的入口必须显式给 `actor` |
| 管理员消息 `admin` | 入口已做本地鉴权，跳过误触防护与原请求者校验 | Web 控制台、CLI 设置；IM 消息不带 |
| 触发词 | 群里消息需以 `trigger`（默认 `/pisa`）开头；私聊 `dmWithoutTrigger` 可省 | `src/commands.ts` 解析；单个英文词默认拒绝，防误触 |
| 白名单 | `whitelist.users` / `whitelist.repos` 任意一项非空即启用 | 同时约束 IM 与触发适配器 |

## 执行

| 术语 | 含义 | 代码位置与约束 |
| --- | --- | --- |
| 守护进程 daemon | 长期运行的 `src/index.ts` 进程，持有队列、通道、触发与调度 | 启动成功打出 `[pisa] ready · …` |
| 心跳 | 守护进程定期写 `meta` 表；距今超过 10 秒视为已停止 | `HEARTBEAT_STALE_MS`；CLI 靠它判断是否能等到结果 |
| Worker | 一次任务对应的 agent 子进程 | `src/worker.ts` 负责超时、空闲检测、输出解析 |
| Worker 适配器 `WorkerAdapter` | 把任务翻译成命令行与提示词，并把输出行翻译成人读文本 | `src/adapters/`；注册表 `REGISTRY`，默认 `omp` |
| `sessionId` | agent 侧的会话 id，用于恢复对话 | 由 Worker 扩展写进进度流，router 落库；适配器的 `parseLine` 不产出它 |
| `resumeSessionId` | 恢复时传给适配器的会话 id | 只有 `resume` 任务且已有 `sessionId` 时非空 |
| 执行超时 `timeoutSec` | 单次任务总时长上限，默认 3600 秒 | 超时杀进程组，任务 `failed` |
| 空闲超时 `idleTimeoutSec` | 多久没有任何输出/进度算卡死，默认 900 秒 | 与总超时分开，长任务一直在输出就不会被杀 |
| 并发 `concurrency` | 同时运行的 Worker 数，默认 2 | 超额任务留在 `queued` |
| 工作目录 `workdir` | 任务专用的 git worktree：`.pisa/worktrees/t_<任务号>` | 分支 `pisa/<任务号>`；续跑复用上一轮分支 |
| 进度流 | `.pisa/progress/<任务号>.jsonl` 的 NDJSON：会话、工具、阶段 | router 监听并翻译成聊天消息；日志 `.pisa/logs/<任务号>.log` 保留原始输出 |
| 孤儿任务 | 进程重启后没有活着的 Worker 接管的 `running` 记录 | 启动 5 秒后对账：工作副本与会话在则 `paused`，否则 `failed` |

## 交付与账本

| 术语 | 含义 | 代码位置与约束 |
| --- | --- | --- |
| 交付 `delivery` | 提交、推送、建 PR 的自动化 | `delivery.push` 关即只提交；`delivery.pr` 关则回执给 compare 链接 |
| 副作用 `Effect` | 任务对外产生的一类改动：`branch` `push` `pr` `comment` `worktree` `merge` | `task_effects` 表；每类内按 `target` 唯一（分支名、远程名、PR 号、仓库#编号、目录、主干名） |
| 账本原则 | 副作用先记账、再做，撤销按账本反向回滚 | 撤销不看 git 现状，只看本任务记过什么 |
| `blocked` | 命中敏感路径未进入提交的文件 | `DeliveryResult.blocked`；任务照常成功，回执必须列出 |
| outbox | 待投递的回复队列：退避 2s→60s，跨重启重试 | `effects` 表；投递成功写隐藏标记，防止重复回帖 |
| 隐藏标记 | 回复正文末尾的不可见去重标记 | 按「任务 + 投递目标」计算；手工回帖不会误判 |
| 对账 `reconcile` | 启动时用 git 与 `gh` 复核账本状态，补齐缺失记录 | 只读探测；不一致时按实际状态修正 |
| 合并 `merge` | 在临时副本跑 `bun test`，通过后 `--ff-only` 合入主干 | 门禁失败不动仓库；合并成功后清理任务分支与工作副本 |

## 运维

| 术语 | 含义 | 代码位置与约束 |
| --- | --- | --- |
| 状态目录 `stateDir` | 默认 `.pisa/`：`pisa.db`、`logs/`、`progress/`、`worktrees/`、`sessions/` | 相对路径按配置文件所在目录解析；备份与清理由它出发 |
| 保留 `retentionDays` | 终态任务的 `events` 与进度文件保留天数，默认 30；≤ 0 关闭清理 | 每小时检查，同一本地日期只清一次；任务行与账本不删 |
| 日志轮转 | 单任务日志超过 10 MiB 转成 `<任务号>.log.1`，只留一代 | 磁盘吃紧先看 `logs/` 与 `worktrees/` |
| 看护 supervisor | `scripts/supervise.sh` + launchd；进程非零退出按 1→30 秒退避拉起 | 见 [deployment.md](./deployment.md#常驻launchd) |
| 常驻退出码 | 正常关停 75（要重启），0 表示主动停止（不再拉起） | 完整清单见 [deployment.md](./deployment.md#退出码) |
| 冷却 `cooldownSec` | 主动发现（关键词、探针）两次触发之间的最小间隔 | `proactive` 配置；冷却期内只记录不建任务 |
| 探针 probe | 周期性执行命令，输出点名了关键词才投递 | 与关键词发现共用冷却；只看新增输出 |
| 调度 schedules | cron 到点用 `prompt` 开单，发送方身份取 `scheduler` | 缺少 `scheduler` 时调度不生效 |

## 易混词

| 对比 | 区别 |
| --- | --- |
| `source` vs `channel` | `source` 是任务来自哪类入口，`channel` 是会话通道；一个 `github-actions` 来源的任务仍可能通过 `telegram` 通道回复 |
| 触发器 vs 任务 | 触发器是事件事实，任务是一次执行；同一线程可有多条触发器但只有一个任务 |
| `messageKey` vs `version` | 前者区分「哪条消息」，后者区分「同一条消息的第几版」 |
| `threadKey` vs `sessionId` | 前者是业务线程（人和事），后者是 agent 会话（对话上下文）；两者不互推 |
| `resume` vs `continue` vs `rewind` | `resume` 恢复被中断的同一任务；`continue` 成功后在同分支开新任务；`rewind` 撤销已完成任务的副作用 |
| `worktree` vs `workdir` | `worktree` 是 git 的工作副本目录，`workdir` 是对它的路径引用；任务的 cwd 永远是 `workdir` |
| 战术查询 `task` vs 看板 | 命令行 `pisa task` 只入队；看板 `/api/tasks` 是只读聚合，不改变状态 |
