<div align="center">

# PISA

**Pi Super Agent** · 用 pi 作底座，把编码 Agent 从「一个会话」变成「一个常驻团队」

![status](https://img.shields.io/badge/status-spec--first-blue)
![base](https://img.shields.io/badge/base-pi-111111)
![method](https://img.shields.io/badge/method-SDD-2f6b5a)
![lang](https://img.shields.io/badge/lang-TypeScript-3178c6)

</div>

---

## 目录

- [为什么做](#为什么做)
- [它是什么](#它是什么)
- [架构](#架构)
- [与 pi 的关系](#与-pi-的关系)
- [目录结构](#目录结构)
- [常驻（launchd）](#常驻launchd)
- [开发方式](#开发方式)
- [路线图](#路线图)
- [当前状态](#当前状态)
- [致谢](#致谢)

## 为什么做

单个编码 Agent 已经很能干，但它仍被绑在一个**会话**上：

- 同时推进三件事，你就要在三个窗口之间来回切换，自己记住每件事的进度
- 上一条命令没跑完，下一条只能等着
- 设备一休眠，任务就停
- 不同任务的上下文混在同一个会话里，互相污染

结果就是：**单任务的上限取决于模型，多任务的上限取决于人的注意力。**

PISA 要把这层限制从人身上移到系统里：会话管理、上下文同步、任务分派由系统负责，人只负责目标设定和结果验收。

## 它是什么

一个常驻在线的 Agent 系统，四个特征：

| 特征 | 含义 |
| --- | --- |
| **连续** | 你在 IM 里定方案 A，在 PR 评论里改成方案 B，它接得上，不用管背后开了几个会话 |
| **高效** | 上一条任务没结束，下一条随时能进；多任务并行推进 |
| **主动** | 监听环境事件，值得处理就处理，不值得就保持安静 |
| **持久** | 始终在线，断线重连能续上，异常能自己恢复 |

核心判断：**没有任何单个 ReAct 循环能同时提供这四个特征**，它们必须来自循环之外的系统架构。

## 架构

```
              IM / GitHub / 邮件 / CI / 定时器
                            │
                  ┌─────────▼─────────┐
                  │      Router       │   常驻 · 全局记忆 · 只分派
                  │   （轻量模型）     │   不直接执行任务
                  └──┬──────┬──────┬──┘
                     │      │      │
            ┌────────▼──┐ ┌─▼────────┐ ┌▼──────────┐
            │ Worker 1  │ │ Worker 2 │ │ Worker N  │  隔离上下文 · 全套工具
            │   (pi)    │ │   (pi)   │ │   (pi)    │  强模型 · 可再开子代理
            └───────────┘ └──────────┘ └───────────┘
```

- **Router**：全局入口，承接所有人类交互，维护跨任务记忆，决定「谁来做」。不碰单任务内部的拆解。
- **Worker**：一个任务一个隔离会话，挂完整工具链，独立目录（git worktree）执行，干完向 Router 汇报。
- **事件驱动**：消息、CI 失败、Issue 变更都是触发器；两级过滤决定哪些值得唤醒 Agent。
- **存算分离**：会话状态与执行环境解耦，设备掉线可恢复。
- **Watchdog**：外部看护进程，负责超时、卡死、重启。

## 与 pi 的关系

pi 提供的是**单体 Agent 运行时**：会话、工具调用、扩展机制、模型适配。

PISA 不重写这些，只在它之上加一层调度：

| 层 | 归属 | 职责 |
| --- | --- | --- |
| 交互与调度 | PISA | Router、任务队列、事件过滤、跨会话记忆 |
| 执行 | pi | 每个 Worker 就是一个 pi 会话，跑完整的 agent loop |
| 能力扩展 | pi extension | 工具、钩子、可观测性，按需挂载 |

pi 的扩展是 TypeScript 文件，`export default async function (pi) { … }`，可订阅会话生命周期事件。PISA 的 Worker 以扩展 + 进程管理的方式接入，不 fork pi。

## 目录结构

```
pisa/
├── AGENTS.md              # 工程规范（工作原则、编码、测试、Git、子代理）
├── SDD.md                 # 规格驱动开发流程
├── README.md
├── docs/
│   ├── constitution.md    # 项目宪法：不可协商的架构与质量约束
│   └── specs/             # 每个 feature 一个目录：spec / plan / tasks
├── src/                   # Router、任务调度、事件总线
├── extensions/            # pi 扩展：进度上报 + 策略拦截
├── scripts/supervise.sh   # 崩溃自动重启
└── tests/
```

## 快速开始

```bash
bun install
cp pisa.config.example.json pisa.config.json   # 改成你的仓库与白名单
bun run src/index.ts --channel cli             # 本地通道
```

Telegram：

```bash
export PISA_TELEGRAM_TOKEN="<bot token>"
# pisa.config.json 里把 channels.telegram.enabled 设为 true
bun run src/index.ts
```

用法：

```
/pisa <需求>            接一个任务
/pisa cancel [任务号]   取消
/pisa help              帮助

私聊里可以直接说需求，不用加 /pisa；群聊仍需触发词。
/status、/cancel、/help 在私聊可直接用。

/pisa continue <任务号> <新要求>   从上一轮的分支和上下文继续做
/pisa resume <任务号>             恢复被进程重启中断的任务（私聊可用 /resume）
/pisa rewind <任务号>             预览并撤销任务的副作用（私聊可用 /rewind）
/pisa status                     任务看板（私聊可用 /status）
```

撤销：

- `/pisa rewind <任务号>` 只读预览：将关闭的 PR、将删除的本地/远程分支、是否已合并、哪些动作不可撤销
- `/pisa rewind <任务号> --yes` 执行；已合并的任务用 `revert` 提交回退，不改写历史
- `gh` 查不到 PR 状态时保留分支、不标记完成，修好后重发
- 任务执行期间的其它外部调用（API、消息、数据库）不在账本内，无法撤销

误触保护：

- 只有一个 token 且与命令编辑距离 ≤ 2（如 `/pisa stats`）不会建任务，直接回复建议命令
- 其余单英文词（如 `/pisa refactor`）先要求确认，回复 `/pisa confirm` 才建任务，10 分钟内有效
- 中文正文与多词正文照常直接建任务

Telegram 启动时用 `setMyCommands` 注册命令菜单（私聊可直接点选）。

`/pisa status` 分三段：

- **运行中**：每行 `任务号 · 仓库 · 已运行 3m12s · 需求前 40 字`
- **排队**：数量 + 最多 5 条 `任务号 · 仓库 · 需求前 40 字`
- **最近完成**：最多 5 条 `状态 · 耗时 · 仓库 · 需求前 30 字 · PR 链接`

末尾一行汇总 `总数 / 成功 / 失败 / 暂停`；某段为空时显示 `(无)`。

进程重启后，工作副本与会话都还在的 `running` 任务进入 `paused`，可用 `resume` 拉回执行；缺任一条的标记 `failed`。

**回复机器人的任意一条任务消息，等于继续那个任务**，不用记任务号。

执行时会实时回传进度（`🛠 命令` / `✏️ 文件`），破坏性命令会在 agent 内部被拦下。

外部事件入口：

```bash
curl -X POST http://127.0.0.1:8799/event \
  -H "x-pisa-token: $PISA_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"跑测试并修掉失败","eventId":"ci:12345"}'
```

执行链路：消息 → 鉴权 → 建任务 → 独立工作副本 → `omp` 执行 → 提交到 `pisa/<任务号>` → 回执。

## 多仓库

`repos` 可以写多个仓库，入口用 `@别名` 指定这次任务落在哪个仓库；不带别名时走第一个（默认仓库）。

```json
{
  "trigger": "/pisa",
  "whitelist": { "users": ["<telegram user id>"], "repos": ["pisa", "family"] },
  "repos": [
    { "alias": "pisa", "path": "/absolute/path/to/pisa", "baseBranch": "main" },
    { "alias": "family", "path": "/absolute/path/to/family", "baseBranch": "main" }
  ]
}
```

```
/pisa @family 改一下首页     群聊或带触发词
@family 改一下首页           私聊可以直接说
```

- 别名在 `repos` 里精确匹配；写错时不会被吞掉，任务仍进默认仓库，正文保留原文
- 别名可以放在触发词前：`@family /pisa 改一下首页` 与 `/pisa @family 改一下首页` 等价
- 接单回执写明 `仓库：<别名>`，不用回忆默认仓库是哪个
- 续跑固定在父任务所在仓库，别名不会把续跑带到别的仓库

## 主动发现

两种触发方式，都不需要人 @：

```json
{
  "proactive": {
    "keywords": {
      "enabled": true,
      "words": ["挂了", "报错", "失败"],
      "cooldownSec": 600
    },
    "probe": {
      "enabled": true,
      "command": "gh run list --limit 1 --json conclusion -q '.[0].conclusion' | grep -q success",
      "intervalSec": 300,
      "chatId": "<telegram chat id>",
      "userId": "<telegram user id>",
      "prompt": "CI 有失败，定位并修复"
    }
  }
}
```

- **关键词**：群里出现这些词且没人带触发词，自动开单（同一群有冷却）
- **探针**：定时跑一条命令，退出码非 0 就开单；命令写法自由，CI、探活、磁盘检查都能接

## 定时任务

cron 到点自动开单，链路与 IM 消息相同：排队、独立工作副本、执行、回执。

```json
{
  "scheduler": { "chatId": "<telegram chat id>", "userId": "<telegram user id>" },
  "schedules": [
    { "id": "morning", "cron": "0 9 * * 1-5", "prompt": "检查昨天以来的 CI 失败并修复", "repo": "pisa" },
    { "id": "monthly", "cron": "0 0 1 * *", "prompt": "升级依赖并跑测试", "enabled": false }
  ]
}
```

- cron 为 5 段 `分 时 日 月 周`，按进程本地时区；支持 `*`、`*/n`、逗号列表、区间 `a-b`、区间步长 `a-b/n`，周 `7` 等同周日
- `scheduler` 决定任务挂在谁的会话下，缺省时 `schedules` 不生效
- `enabled: false` 保留配置但不触发；`repo` 省略时走默认仓库
- 每 30 秒检查一次；同一分钟只投一次，进程重启也不会重投
- `id` 重复或 cron 非法的 job 在启动日志告警后跳过，不影响其他 job
- `/pisa schedules`（私聊 `/schedules`）查看 id、cron、仓库与启用状态

## 数据保留

事件去重记录、进度文件、任务日志都会随运行时间增长，按下面的规则回收：

```json
{ "retentionDays": 30 }
```

- `retentionDays` 默认 30；≤ 0 关闭每日清理，回收照常
- 每小时检查一次，启动时立即跑一次；同一本地日期只清理一次，重启不重复
- 清理对象：结束时间早于 `now - retentionDays` 的终态任务（成功 / 失败 / 取消 / 撤销）的 `events` 行与 `.pisa/progress/<任务号>.jsonl`；任务行与账本保留，看板与撤销照常可用
- 不属于任何任务的占位行（cron 每分钟占位等）按写入时间过期；不这样清它们没有任务行可依附，永远涨
- 清理自身的占位只保留当日与当周两个键，历史键删除；这些键不按时间过期，否则保留期短于一周时同一周会重复 VACUUM
- 单个 progress 文件删不掉（权限、目录占位）只计数告警，不影响其余文件与 `events` 清理
- 单个任务日志超过 10 MiB 时轮转为 `<任务号>.log.1`，只保留一代，主文件继续写；单行自身超过上限时截断并加 `…[truncated]`，保证主文件不超过上限
- 每周 VACUUM 一次并 checkpoint，数据库文件实际缩小；同一 ISO 周只执行一次

## GitHub 评论（PR / Issue）

评审人和维护者可以直接在 PR / Issue 评论里派活，不用绕回 IM：

```json
{
  "github": {
    "enabled": true,
    "intervalSec": 120,
    "tokenEnv": "GH_TOKEN",
    "repos": [
      { "repo": "owner/pisa", "chatId": "<telegram chat id>", "userId": "<telegram user id>" },
      { "repo": "owner/site", "chatId": "<telegram chat id>", "userId": "<telegram user id>" }
    ]
  }
}
```

- `repos` 里的每个仓库独立轮询、独立增量下界；`intervalSec` 与 `tokenEnv` 仍是全局配置
- 旧的单仓库写法 `repo` + `chatId` + `userId` 继续可用；`repos` 非空时优先，旧字段被忽略
- 某个仓库拉取或类型判定失败只影响它自己：本轮不推进它的下界，其它仓库照常
- 轮询仓库的 Issue 评论（PR 评论走同一个 API），默认 120 秒一轮
- 只认正文（去首尾空白）以 `/pisa ` 开头的评论，其余一律忽略
- 启动时刻作为下界，不回放历史评论；拉取失败不推进下界，下一轮继续
- 同一条评论按「仓库 + 评论 id」去重（事件 id `github:comment:<repo>:<id>`），重启、轮询重叠都只建一个任务
- 编号先判定类型（`gh api repos/<repo>/issues/<n>` 看有没有 `pull_request`）：失败就不投递，该仓库本轮也不推进下界
- PR 上已有成功任务时直接在该任务的分支上继续并更新原 PR（不新开分支、不新建 PR）；任务按仓库匹配，`o/a#7` 与 `o/b#7` 互不干扰。上下文带 PR 号与原评论；没有就按普通任务处理，正文是去掉触发词的部分
- Issue 评论产生的任务从主干开新分支，不继承任何父分支；完成后把摘要回帖到该 Issue
- Issue 来源的任务新建 PR 时，正文追加一行 `Closes #<n>`，合并 PR 后自动关闭 Issue
- 复用分支的任务失败或取消时保留共享分支；任务自己新建的 `pisa/<任务号>` 才会被清理
- 任务成功后把摘要（限 3000 字）回帖到评论所在的仓库；旧任务或没有仓库记录时回退到配置里的单仓库；回帖失败只写日志，任务状态不变
- GitHub 评论产生的任务仍落在本地默认仓库：配置里没有 GitHub 仓库到本地别名的映射

`gh` 需要认证：`tokenEnv` 指定的环境变量（默认 `GH_TOKEN`）会被读进 `process.env.GH_TOKEN`，`gh` 只认 `GH_TOKEN` / `GITHUB_TOKEN`。评论作者不参与鉴权，任务归属由各仓库条目的 `chatId` / `userId` 决定（旧写法为顶层字段）。

## 自举

pisa 可以改自己：

1. 给机器人发需求（或从 webhook 投递），Worker 在 `pisa/<任务号>` 分支上改代码
2. `/pisa merge <任务号>`：在临时副本跑 `bun test`，通过后 `--ff-only` 合入 `main`
3. 看护模式（`PISA_SUPERVISED=1`）下进程退出，`scripts/supervise.sh` 拉起新代码

这条链路已经实测：任务改 README → merge → 进程 PID 变化 → 新内容生效。

## 常驻（launchd）

`scripts/supervise.sh` 交给 launchd 托管：开机自启，进程退出后自动拉起。

安装（重复执行等于重装）：

```bash
./scripts/install-launchd.sh
```

脚本生成 `~/Library/LaunchAgents/ai.pisa.supervisor.plist` 并加载，工作目录是仓库根目录，日志写在 `~/Library/Logs/pisa.launchd.log`（外部卷上的路径 launchd 无权限写入）。多份 worktree 同时安装会互相覆盖，只保留一份。

看日志：

```bash
tail -f ~/Library/Logs/pisa.launchd.log
launchctl print gui/$(id -u)/ai.pisa.supervisor    # 状态
```

卸载：

```bash
launchctl bootout gui/$(id -u)/ai.pisa.supervisor
rm ~/Library/LaunchAgents/ai.pisa.supervisor.plist
```

token 不进 plist：`supervise.sh` 启动时从环境变量取，缺省读 `~/.pisa/telegram_token` 与 `~/.pisa/webhook_token`。

## 开发方式

本项目使用 **规格驱动开发（SDD）**，流程见 [SDD.md](./SDD.md)：

```
specify → plan → tasks → implement → converge
```

规则摘要：

- 规格是唯一事实源，改代码前先改规格
- `spec.md` 只写 WHAT / WHY，技术选型属于 `plan.md`
- 每条需求有 ID（`US-1` / `FR-001` / `NFR-001`），任务与测试都能回溯
- 先写失败测试，再写实现
- 一次只做一个 feature，一个 feature 一个分支

工程规范见 [AGENTS.md](./AGENTS.md)：SSOT、深度封装、插件化、日志可观测、禁止技术债。

## 路线图

| 阶段 | 目标 | 验收 |
| --- | --- | --- |
| **P0** | Router + 单 Worker：一个入口收消息，分派给一个隔离会话执行，结果回到原对话 | 一条 Issue 能被接单、执行、回复 |
| **P1** | 多 Worker 并行（已完成）+ 任务与讨论的订阅绑定 | 三件事并行，互不串上下文 |
| **P2** | 事件驱动与主动发现：CI 失败、群聊报障在无人 @ 时自动接手 | 无指令场景下产出可评审的 PR |
| **P3** | 持久化与自愈：会话状态外置、断线重连、Watchdog | 杀掉进程后任务可续跑 |

## 当前状态

**P0、P1、P2、P3 已实现；路线图里还有两项没做。**

已完成：

- P0：单 Worker 闭环，真实 omp 跑通（改文件 → 提交到 `pisa/<任务号>` → 主分支零改动）
- P1：并发上限可配（默认 2），任务级隔离，`/pisa status` 查看状态
- P2：webhook 事件入口（CI/监控可直接投递任务）
- P3：崩溃自动重启、孤儿任务收口、任务级超时
- pi 集成：Worker 挂 pisa 扩展，工具级进度上报 + 命令拦截 + 分支续跑
- 自举：`/pisa merge` 验证后合入主干，看护进程拉起新代码
- 订阅绑定：回复任务消息即续跑（消息 → 任务映射落库）
- GitHub 评论：`/pisa` 触发多仓库轮询（`github.repos`，旧的单仓库写法兼容），按仓库隔离增量下界、去重与回帖；PR 上已有任务则接续分支，普通 Issue 从主干开新分支；完成后回帖到评论所在仓库，Issue 来源的 PR 带 `Closes #<n>`
- 主动发现：群聊关键词 + 定时探针
- 定时任务：cron 到点自动开单，同一分钟只投一次；`/pisa schedules` 查看
- Worker 适配器：`worker.adapter` 可换，omp 只是其中一个实现
- 交付：`delivery.push` 已验证（本地裸仓库）；PR 创建走 `gh`，未配远程时退回对比链接
- 测试 89 个全绿；`tsc --noEmit` 无报错
- 已接入 Telegram（@lzf_pisa_bot）

未完成（路线图原计划）：

- P3 真正的会话持久化——仍用「上一轮分支 + 上下文注入」替代
- `gh pr create` 未实测——仓库没配远程，只在本地裸仓库验证了 push

## 致谢

- 架构思路来自 DeepSeek Harness 团队《Super-agent 设计探索：迈向更自主的 Agent 系统》（2026-10-31）
- 底座 [pi](https://github.com/earendil-works/pi) —— 会话、工具与扩展运行时
- 规格流程参考 [GitHub spec-kit](https://github.com/github/spec-kit/blob/main/spec-driven.md)
