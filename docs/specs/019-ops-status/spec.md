# 019 · 运维状态与小时巡检

- 状态：implemented
- 关联：018-health-metrics（`/health` 的 `ok` 只回答守护进程心跳）、014-retention（每小时 tick 的既有模式）、010-status-board（看板）
- 依赖：无

## 1. 问题

看板只给人看，脚本没有稳定的判断出口：

- `pisa status` 无论守护进程在不在都返回 0（复现：临时配置、没有心跳记录时运行 `pisa status`，`$?` 为 0），监控无法据此告警
- 组件配错（Telegram 已启用但缺 token、GitHub 已启用但没有归属、cron 写错）只在启动日志里 warn 一次，进程跑起来后没人知道
- 没有小时级巡检；半夜进程挂掉或配置坏掉，要到白天人工翻日志才发现
- 即使加上巡检，同一个问题每小时重复提醒会刷屏

## 2. 目标

- `pisa status` 用退出码表达四种运维结论：0 正常 / 1 需重启 / 2 部件错误 / 3 待配置
- 提供一次性的 `pisa patrol`，交给 launchd 每小时执行；正常不输出任何内容
- 同一问题只提醒一次：按问题 key 去重，问题消失后清除记录，再次出现重新提醒
- 健康判定只有一份实现，`status` 与 `patrol` 共用

## 3. 口径

| 码 | 结论 | 判定 |
| --- | --- | --- |
| 0 | 正常 | 没有下列任何问题 |
| 1 | 需重启 | 守护进程心跳超过 `HEARTBEAT_STALE_MS`（10s）或从未心跳 |
| 2 | 部件错误 | 已启用的部件配置不完整：Telegram / Webhook / GitHub / 定时任务 / Web 控制台 |
| 3 | 待配置 | `repos` 为空，无法派活 |

多个问题同时存在时取最靠后的码（3 > 2 > 1 > 0）：配置缺失优先修复，其次修部件，最后才是拉起进程。

宽限期外的已知取舍：`whitelist.users` 为空不算待配置，因为只用 CLI 的部署不经过白名单。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/ops.ts`：`OpsCode`（0/1/2/3）、`OpsLevel`（`ok`/`restart`/`component`/`config`）、`OpsIssue`（`key`/`level`/`message`）、`OpsHealth`（`code`/`level`/`issues`）、`opsHealth()` |
| FR-002 | `opsHealth()` 只读：读配置、环境变量、`store.lastBeat()`；不写库、不启动进程、不发消息 |
| FR-003 | 待配置：`repos` 为空 |
| FR-004 | 部件错误：`channels.telegram.enabled` 且缺 `tokenEnv` 指向的变量；`webhook.enabled` 且缺 token 或 `chatId`/`userId`；`github.enabled` 且 `githubRepos()` 为空；`schedules` 非空但缺 `scheduler.chatId/userId`；定时任务 id 重复或 cron 非法；`web.enabled` 且 `web.userId` 不在 `whitelist.users` |
| FR-005 | 需重启：`daemonState(store, now).alive === false` |
| FR-006 | `pisa status` 的文本输出在守护进程行后追加健康块：`健康：正常` 或 `健康：<结论>（退出码 N）`，每个问题一行 `- <message>`；`status --json` 增加 `health` 字段 |
| FR-007 | `pisa status` 的退出码等于健康码；未找到配置文件时直接返回 3，不抛用法错误 |
| FR-008 | 新增 `pisa patrol [--json]`：调用 `patrolTick()`；健康时清空去重记录且不输出；有**新**问题时输出告警并通过 Telegram 发送（见 FR-010），退出码等于健康码 |
| FR-009 | 去重记录落在 `meta` 的 `patrol:alerted`，值为当前问题 key 的换行连接；同一 key 不再提醒；问题消失后 key 从记录里移除（恢复后清零） |
| FR-010 | 告警投递：配置 `patrol.chatId` 且 `channels.telegram.tokenEnv` 对应变量存在时，用 `TelegramChannel` 发到该 chat；否则只写 stdout（launchd 日志）。投递失败不写去重记录，下一小时重试 |
| FR-011 | `Config` 增加可选 `patrol: { chatId?: string }`；不配置时巡检仍运行，只输出到 stdout |
| FR-012 | `scripts/patrol.sh` 按 `supervise.sh` 的方式从环境变量或 `~/.pisa/` 文件加载 token，然后 `exec bun run src/cli.ts patrol` |
| FR-013 | `scripts/install-launchd.sh` 额外安装 `ai.pisa.patrol`，`StartInterval` 为 3600 秒 |

## 5. 验收

1. 没有心跳记录时 `pisa status` 退出 1，输出含 `健康：需重启`；心跳新鲜时退出 0
2. `repos` 为空时退出 3；同时存在缺 token 与无心跳时仍退出 3
3. Telegram 启用但缺 token、cron 非法、GitHub 无归属时退出 2
4. `pisa patrol` 第一次输出问题，第二次同一问题静默，恢复后再次出现重新输出
5. `patrol:alerted` 只保留当前问题 key；健康时清空
6. 告警回调只在有新问题时调用一次
7. `tests/ops.test.ts` 覆盖四种码、优先级与去重/清零；`tests/cli.test.ts` 覆盖 status / patrol 的退出码与静默
8. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 不改 `/health` 的 `ok` 判定，也不把健康码塞进 HTTP 状态码
- 不引入外部监控依赖、不写 Prometheus 指标
- 不自动修复（不重启守护进程、不改配置）
- 不把 `whitelist.users` 为空当作待配置
- 不改变其它 CLI 命令的退出码语义
