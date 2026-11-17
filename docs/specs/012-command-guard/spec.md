# 012 · 命令误触防护

- 状态：implemented
- 关联：001（`parseCommand` 入口语法）、002（`status` 命令）
- 依赖：无

## 1. 问题

入口解析对「触发词之后的未知首词」一律当成任务正文。用户在群里输入 `/pisa stats`（本意 `/pisa status`），pisa 直接建任务并开工作副本、跑 agent、推分支。单英文词同样危险：`/pisa refactor` 会被当成一次真实任务执行。

## 2. 目标

- 与已知命令编辑距离 ≤ 2 的单 token 不建任务，回复建议命令
- 其余单 ASCII 词先要求确认，确认后才建任务
- 中文正文、多词正文的行为不变，直接建任务
- 启动时向 Telegram 注册命令菜单（`setMyCommands`）

## 3. 用户故事

### US-1 打错命令不误开单

作为使用者，我输入 `/pisa stats`，pisa 回「你要用的是：/pisa status」，不产生任务。

### US-2 单英文词先确认

作为使用者，我输入 `/pisa refactor`，pisa 问「确认要把它当成任务吗」，我回复 `/pisa confirm` 后才建任务。

### US-3 中文照常

作为使用者，我输入 `/pisa 修复登录`，直接建任务，没有任何附加确认。

### US-4 私聊有命令菜单

作为使用者，我在 Telegram 私聊里点开命令菜单，能看到 pisa 支持的命令及说明。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 命令清单收敛为 `config.ts` 的 `COMMANDS` 单一事实源：英文名、中文别名、说明、是否进菜单。`parseCommand` 由它驱动 |
| FR-002 | 新增纯函数 `taskGuard(body)`：正文是单个 ASCII 词时，若与菜单命令的 Levenshtein 距离 ≤ 2 返回 `suggest` + 最近命令；否则返回 `confirm`；非单 ASCII 词返回 `null` |
| FR-003 | Router 对 `task` 类命令先过 `taskGuard`：`suggest` 只回复建议命令，不建任务、不登记事件；`confirm` 记住待确认正文（键 `chatId:userId`，10 分钟过期）并回复确认提示 |
| FR-004 | 新增命令 `confirm`（`/pisa confirm`，私聊可用 `/confirm`）：有待确认正文时以原仓库建任务，无待确认或已过期时回复提示，不建任务 |
| FR-005 | 私聊未知 `/xxx` 若是命令错拼，回复建议；不是单词时保持旧行为（忽略） |
| FR-006 | `ChannelAdapter` 增加可选 `setCommands`；`TelegramChannel` 用 `setMyCommands` 实现；启动时注册 `BOT_COMMANDS`（不含 `confirm`），注册失败只告警不阻断启动 |
| FR-007 | 中文正文与多 token 正文直接走任务，行为不变 |

## 5. 验收

1. `/pisa stats` 后任务数为 0，回复包含 `/pisa status`
2. `/pisa refactor` 后任务数为 0，回复要求确认；随后 `/pisa confirm` 产生 `prompt = "refactor"` 的任务
3. `/pisa 修复登录` 直接产生任务
4. 无待确认时 `/pisa confirm` 不建任务，回复提示
5. 私聊 `/stats` 不建任务，回复建议 `/status`
6. 启动注册的 `setMyCommands` 载荷包含 `status`、`cancel`、`resume`、`continue`、`merge`、`schedules`、`help`，不含 `confirm`

## 6. 非目标

- 多 token 正文的模糊匹配（`/pisa stat now` 仍按任务处理）
- 待确认状态持久化：进程重启后丢失，重新发送即可
- 非 Telegram 通道的命令菜单
