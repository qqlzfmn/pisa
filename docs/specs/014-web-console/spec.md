# 014 · Web 控制台

- 状态：implemented
- 关联：`src/web/`；配置字段 `web.enabled` / `web.port`
- 依赖：010（任务看板语义）、013（rewind 计划）

## 1. 问题

日常维护的三个动作现在都离开不终端或聊天窗口：

1. rewind 只能靠 `/pisa rewind <任务号> [--yes]`，要先自己记住任务号，预览和执行混在一条命令里。
2. 改 repos / worker 并发 / schedules 必须手改 `pisa.config.json` 再重启，写错 JSON 会直接让进程起不来。
3. 成功率、耗时、队列深度没有任何汇总入口，只能翻 `tasks` 表。

## 2. 目标

- 一个本机页面同时给出：任务列表（可挑选 rewind 目标）、rewind 预览与执行、配置表单、三张指标图。
- 配置保存前在服务端校验，非法配置不落盘；保存成功明确提示「重启后生效」。
- 所有写操作（rewind 执行、配置保存）必须先预览拿到确认令牌，再带令牌执行；每次都写审计日志。

## 3. 用户故事

### US-1 预览并撤销任务

作为维护者，我在任务列表里点「撤销」，先看到将执行的动作、不可撤销项和保留项，确认后才真正执行。

### US-2 可视化改配置

作为维护者，我在页面上改仓库清单、worker 并发/超时、定时任务，保存时报错具体到字段，成功后知道要重启。

### US-3 看趋势

作为维护者，我在页面上看到最近 7 天的成功率和平均耗时、最近 24 小时的队列深度。

### US-4 可追溯

作为维护者，我能看到最近写操作的时间、动作、目标、结果。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `web.enabled`（默认 `false`）、`web.port`（默认 `8788`）；启用后只监听 `127.0.0.1` |
| FR-002 | `GET /` 返回服务端渲染的页面；`GET /api/state` 返回同一份数据的 JSON |
| FR-003 | 任务列表展示最近 50 条：任务号、状态、仓库、需求预览、耗时、PR 链接；终态任务带「撤销」入口 |
| FR-004 | `POST /api/rewind/preview {taskId}` 复用 `planRewind`，返回结构化计划、文本预览与确认令牌；任务不存在 404，未结束（queued/running/paused）409，仓库未配置 409 |
| FR-005 | `POST /api/rewind/apply {taskId, token}` 校验令牌（5 分钟、单次、绑定任务号），再复用 `applyRewind`；成功后删除已撤销的副作用，全部成功且合并状态已知时把任务置为 `rewound` |
| FR-006 | `POST /api/config {patch, dryRun?}` 校验 `repos`、`worker`、`scheduler`、`schedules`；非法返回 422 与逐条错误，文件不变 |
| FR-007 | 校验项：仓库别名非空且唯一、路径非空；`worker.adapter`/`command` 非空、`timeoutSec` 为 1–86400 整数、`concurrency` 为 1–64 整数、`extraArgs` 为字符串数组；定时任务 id 非空且唯一、cron 合法、prompt 非空、repo 必须是已有别名、enabled 为布尔；配置了 schedules 时必须有 `scheduler.chatId`/`scheduler.userId`；`scheduler` 两项给值时必须是字符串 |
| FR-008 | 合法且 `dryRun` 时返回确认令牌；不带令牌的保存返回 428；带令牌保存只改 patch 涉及的键，其余键原样保留，用临时文件 + rename 原子写入 |
| FR-009 | 保存成功响应包含 `requiresRestart: true`，页面提示「重启 pisa 后生效」 |
| FR-010 | 审计表 `audit_log(at, actor, action, target, detail, ok)`；rewind 预览不记，rewind 执行与配置保存（含被拒绝的保存）各记一条 |
| FR-011 | 指标取数窗口为「最近 8 天内创建或结束的任务」，跨天完成的任务按完成时间计入 |
| FR-012 | 指标一：最近 7 天按完成日期分桶的成功率（`succeeded / (succeeded+failed+cancelled)`，无终态为 `null`） |
| FR-013 | 指标二：最近 7 天按完成日期分桶的平均耗时（秒），只统计 `succeeded`，从 `startedAt ?? createdAt` 到 `endedAt` |
| FR-014 | 指标三：最近 24 小时按小时采样队列深度，排队区间 `[createdAt, startedAt ?? endedAt ?? now)`，运行区间 `[startedAt, endedAt ?? now)` |
| FR-015 | 图表为服务端生成的内联 SVG，不依赖外部 JS/CSS |

## 5. 验收

1. 非法 `worker.concurrency`（0、字符串、小数）与重复仓库别名、非法 cron、未知 schedule repo 保存时返回 422，且配置文件字节不变。
2. 有定时任务但缺 `scheduler` 身份时返回 422，页面上可直接补 `chatId`/`userId` 后保存。
3. 合法保存只改 patch 覆盖的键，`trigger`、`delivery`、未知自定义键保留。
4. rewind：预览拿到令牌后执行成功返回 200；重放同一令牌返回 409；不带令牌返回 428。
5. 执行成功与保存成功各在 `audit_log` 留一条 `ok = 1`；非法保存留一条 `ok = 0`。
6. `dailyMetrics` 对构造的任务给出正确成功率与平均耗时；`queueDepth` 在给定时刻给出正确排队/运行数量。
7. `bun test` 与 `bunx tsc --noEmit` 通过。

## 6. 非目标

- 鉴权与多用户权限（只监听本机回环地址）
- 在线重启 pisa、运行中任务的实时推送刷新
- 页面创建任务、取消任务
- 编辑 `github` / `proactive` / `channels` 等其余配置段
