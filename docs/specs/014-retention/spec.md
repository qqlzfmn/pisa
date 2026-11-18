# 014 · 数据保留与轮转

- 状态：implemented
- 关联：README「数据保留」；`001-router-worker` NFR-002（任务日志保留 ≥ 30 天）
- 依赖：无

## 1. 问题

`events`、`.pisa/progress/*.jsonl`、`.pisa/logs/*.log` 只有写入路径：

- `events` 每去重一条消息写一行；`cron-claim:*` 每 job 每分钟一行，一年五十万行
- 每个任务的 progress 与日志文件在任务结束后原样留在磁盘
- 数据库没有回收，删掉的页也不会还给文件系统

长期运行后查询变慢、磁盘只增不减。

## 2. 目标

- 配置一个保留天数，过期数据自动清理，任务行本身保留（看板与撤销仍可用）
- 单个日志文件有上界，不会无限增长
- SQLite 空间周期性回收
- 幂等：进程多次重启不重复清理，不同天、不同周各执行一次

## 3. 用户故事

### US-1 长期运行不占满磁盘

作为维护者，pisa 常驻三个月后，`events` 只保留最近 30 天的去重记录，过期任务的 progress 文件已删除，数据库文件大小随 VACUUM 回落。

### US-2 老任务仍可查

作为维护者，30 天前完成的任务仍能在看板与撤销里看到；只有它的 events 与 progress 文件被清掉。

### US-3 单个日志文件不会失控

作为维护者，一个长时间重试的任务把日志写到 10 MiB 时自动轮转出一代备份，主文件继续写。

### US-4 配置可调

作为维护者，我把 `retentionDays` 改成 7，一周前的终态任务数据在次日清理时消失；改成 0 时清理关闭，只有 VACUUM 继续。

## 4. 需求

```json
{ "retentionDays": 30 }
```

| ID | 需求 |
| --- | --- |
| FR-001 | `Config.retentionDays` 可选，缺省 30（`DEFAULT_CONFIG`）。非整数按截断处理；≤ 0 或非数视为关闭每日清理，VACUUM 不受影响 |
| FR-002 | 每小时 tick 一次，启动时立即跑一次；跨天后第一个 tick 执行当日清理，停机错过的那天在下次启动补上 |
| FR-003 | 每日清理的幂等键是 `events` 表里的 `retention:cleanup:<本地日期>`（`task_id = "retention"`），同一本地日期只执行一次，重启不重复 |
| FR-004 | 清理范围一：状态为终态（`succeeded` / `failed` / `cancelled` / `rewound`）且 `COALESCE(ended_at, created_at) < now - retentionDays 天` 的任务，删除其 `events` 行与 `.pisa/progress/<taskId>.jsonl`；`tasks` 行、`task_effects` 行保留 |
| FR-005 | 边界：结束时间恰好等于 cutoff 的任务保留（严格小于才过期）；非终态任务无论多老都不清理，其 events 与 progress 保留 |
| FR-006 | 清理范围二：`seen_at < cutoff` 且 `task_id` 不属于任何任务行的 events（cron 每分钟占位、被拒绝请求留下的孤儿占位等）按时间清理，否则这类行永远涨 |
| FR-007 | 保留自身的占位行（`task_id = "retention"`）不参与范围一；旧的占位行按 FR-006 过期，当日/当周键不受影响 |
| FR-008 | 每周 VACUUM 一次，幂等键 `retention:vacuum:<ISO 周>`；与清理在同一次 tick 内，先清理后回收 |
| FR-009 | 终态任务日志按大小轮转：写入前若「当前大小 + 新行」超过上限（默认 10 MiB），先把文件改名为 `<taskId>.log.1`（覆盖上一代），只保留一代 |
| FR-010 | 清理行数、progress 文件数与是否 VACUUM 通过一次日志输出，便于观测；失败只告警，不影响进程 |
| FR-011 | 纳入 shutdown：进程退出时停止 tick |

## 5. 验收

1. 31 天前结束的终态任务：events 与该任务的 progress 文件被删；29 天前的保留；恰好 30 天前的保留
2. 终态任务的 `tasks` 行在清理后仍可查询
3. 90 天前创建但仍在 `queued` / `running` / `paused` 的任务不被清理
4. 同一本地日期 tick 两次只清理一次，第二次返回零；次日再 tick 才执行
5. 同一 ISO 周只 VACUUM 一次，跨周再执行
6. `retentionDays: 0` 时清理关闭，VACUUM 照常
7. 日志超过上限后出现 `<taskId>.log.1`，没有 `.log.2`；主文件大小不超过上限
8. `DEFAULT_CONFIG.retentionDays === 30`
9. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 删除任务行、工作副本、分支或账本（撤销与审计仍需要）
- 按总量上限（行数/字节）而不是时间清理
- 日志压缩、外部日志收集、按天滚动
- 定时清理的可配置时间点（跟随进程启动与每小时 tick）
