# 021 · 状态退出码与小时巡检

- 状态：implemented
- 关联：010-status-board（看板）、018-health-metrics（心跳与 24h 指标）、009-scheduler（发送方身份）、004-subscription-proactive（探针去重）
- 依赖：无

## 1. 问题

`pisa status` 只输出看板文本，任何情况下都返回 0。脚本、cron、外部监控无法据此分支；半夜守护进程停止后，只能靠人翻 `.pisa/logs` 或第二天发现任务卡住才知道。

证据（改动前）：`src/cli.ts` 的 `status` 分支固定 `return EXIT.ok`，即使输出里有 `守护进程：未运行（无心跳记录）`；`src/index.ts` 只启动关键词与探针，没有任何按状态巡检的定时器。

## 2. 目标

- `pisa status` 用退出码表达四种状态：0 正常、1 需重启、2 部件错误、3 待配置
- 守护进程内每小时跑一次同一套判定：正常静默；异常投递一条消息
- 同一问题在恢复前只提醒一次；状态恢复正常后清零，下次再坏重新提醒
- 判定逻辑只有一份，CLI 与巡检共用

## 3. 判定口径

按「下一步该做什么」排优先级，一条状态可以同时命中多项，进程退出码取最高优先级：

| 退出码 | 含义 | 判定 |
| --- | --- | --- |
| 3 | 待配置 | `repos` 为空，系统还没有可接单的仓库 |
| 2 | 部件错误 | `effects` 表存在 `status='failed'` 的行：外部动作重试用尽，重启不会自愈 |
| 1 | 需重启 | 守护进程心跳缺失或超过 10 秒（`daemonState`） |
| 0 | 正常 | 以上都不成立 |

同一问题用稳定的 key 标识：`config:repos`、`effect:<kind>:<key>`、`daemon:heartbeat`。巡检按有序 key 集合生成签名，签名不变就不重复提醒。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/ops-status.ts`：`OPS_EXIT`、`OpsIssue`、`OpsStatus`、`evaluateOpsStatus(cfg, store, now)`、`formatOpsIssues(issues)` |
| FR-002 | `evaluateOpsStatus` 按 §3 产生 issues 并按 3 → 2 → 1 选出 `exitCode`；无 issue 时为 0 |
| FR-003 | `Store.failedEffects(limit)`：按 `updated_at` 倒序返回 `status='failed'` 的 outbox 行 |
| FR-004 | `pisa status` 以 `evaluateOpsStatus` 的 `exitCode` 退出；文本模式把 issues 写到 stderr，正常时不额外输出 |
| FR-005 | `pisa status --json` 增加 `ops: { exitCode, label, issues }` |
| FR-006 | 新增 `src/patrol.ts` 的 `StatusPatrol`：默认每 3600 秒跑一次，启动时立即跑一次；`proactive.patrol.enabled === false` 关闭 |
| FR-007 | 巡检身份取 `proactive.patrol.chatId/userId`，缺省回落到 `scheduler.chatId/userId`；都缺时启动告警一次并不启动定时器 |
| FR-008 | 巡检签名写入 `meta` 的 `patrol:status`：签名相同不投递；`exitCode === 0` 时清空该键 |
| FR-009 | 异常消息包含退出码、中文含义与全部 issue；`eventId` 由签名与触发时刻推导，重复投递由事件账本吞掉 |
| FR-010 | `src/index.ts` 启动并停止 `StatusPatrol`；`pisa.config.example.json`、`docs/operations.md`、`CHANGELOG.md` 同步 |

## 5. 验收

1. 无仓库配置 → `pisa status` 退出码 3；有 failed effect → 2；无心跳 → 1；三者都正常 → 0
2. 同时命中多项时按 3 → 2 → 1 取码，issues 仍全部列出
3. `pisa status` 文本模式异常时 stderr 出现「巡检：需重启 / 部件错误 / 待配置」与明细；退出码与文本一致
4. `--json` 的 `ops.exitCode` 与进程退出码一致
5. 巡检：首次异常投递 1 条；同签名重复 tick 不投递；签名变化投递；恢复正常后 `patrol:status` 清空，再次异常重新投递
6. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 不做外部存活探针（守护进程死掉后无法给自己巡检）；外部监控直接消费 `pisa status` 退出码
- 不自动重启进程、不自动重试 failed effect
- 不把巡检结果写进 Web 控制台或 `/health`
- 不新增表：去重状态复用 `meta`
