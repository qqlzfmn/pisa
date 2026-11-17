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
```

执行时会实时回传进度（`🛠 命令` / `✏️ 文件`），破坏性命令会在 agent 内部被拦下。

外部事件入口：

```bash
curl -X POST http://127.0.0.1:8799/event \
  -H "x-pisa-token: $PISA_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"跑测试并修掉失败","eventId":"ci:12345"}'
```

执行链路：消息 → 鉴权 → 建任务 → 独立工作副本 → `omp` 执行 → 提交到 `pisa/<任务号>` → 回执。

## 自举

pisa 可以改自己：

1. 给机器人发需求（或从 webhook 投递），Worker 在 `pisa/<任务号>` 分支上改代码
2. `/pisa merge <任务号>`：在临时副本跑 `bun test`，通过后 `--ff-only` 合入 `main`
3. 看护模式（`PISA_SUPERVISED=1`）下进程退出，`scripts/supervise.sh` 拉起新代码

这条链路已经实测：任务改 README → merge → 进程 PID 变化 → 新内容生效。

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

**P0、P1 并行、pi 集成与自举已实现；路线图里还有三项没做。**

已完成：

- P0：单 Worker 闭环，真实 omp 跑通（改文件 → 提交到 `pisa/<任务号>` → 主分支零改动）
- P1：并发上限可配（默认 2），任务级隔离，`/pisa status` 查看状态
- P2：webhook 事件入口（CI/监控可直接投递任务）
- P3：崩溃自动重启、孤儿任务收口、任务级超时
- pi 集成：Worker 挂 pisa 扩展，工具级进度上报 + 命令拦截 + 分支续跑
- 自举：`/pisa merge` 验证后合入主干，看护进程拉起新代码
- 测试 20 个全绿；`tsc --noEmit` 无报错
- 已接入 Telegram（@lzf_pisa_bot）

未完成（路线图原计划）：

- P1 任务与讨论的订阅绑定（PR 评论、Issue 回复接续）——未实现
- P2 主动发现（CI 失败、群聊报障无人 @ 时自动接手）——只做了被动 webhook
- P3 会话状态外置与断线重连——当前用「上一轮分支 + 上下文注入」替代，不是真正的会话持久化
- Agent 无关的 `WorkerAdapter`——Worker 仍绑定 omp 的 `--mode=json` 输出格式
- push / PR 交付——代码在，配置关闭，仓库也未配远程

## 致谢

- 架构思路来自 DeepSeek Harness 团队《Super-agent 设计探索：迈向更自主的 Agent 系统》（2026-10-31）
- 底座 [pi](https://github.com/earendil-works/pi) —— 会话、工具与扩展运行时
- 规格流程参考 [GitHub spec-kit](https://github.com/github/spec-kit/blob/main/spec-driven.md)
