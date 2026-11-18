# 017 · 外部动作的 Outbox

- 状态：implemented
- 关联：005（崩溃恢复）、006（回帖去重）、013（副作用账本）

## 1. 问题

推送、建 PR、回帖都是「先调用，成功后写库」。进程在动作完成与落库之间崩溃时，库里没有任何记录说明动作发生过，重启后既不会补记，也不会补做；反过来，调用方重试时也没有键可以去重。

复现（`repro-outbox.ts`，已删）：

- 回帖：gh 一次限流，任务仍然 `succeeded`，日志写一行「回帖失败」，之后 `drainOnce()` 再跑一遍也不会重试。
- 建 PR：第一轮创建 PR #9，记账前崩溃；第二轮 gh pr list 抖动，`claimPr` 退化到 `gh pr create`，实际创建两个 PR（#9、#10）。

根因：外部动作的结果只存在于调用栈里。没有一张先落库、再执行、失败可重放的记录。

## 2. 目标

- 外部动作先落库再执行，库里能查到「失败了、下次什么时候再试」
- 进程崩溃重启后，未完成的外部动作继续执行
- 同一 `(kind, key)` 只产生一次外部动作
- 失败按指数退避重试，2s 起、60s 封顶，超过上限后终止并留错因
- 任务最终状态和回执行为不变：回帖失败不把成功的任务判失败

## 3. 用户故事

### US-1 运维

作为运维，进程在动作完成后被 kill，重启后不会出现重复 PR 或重复评论，也不需要人工删重复。

### US-2 请求者

作为发需求的人，GitHub 抖动导致回帖失败时，恢复后能收到那条回帖，而不是永远静默。

### US-3 维护者

作为维护者，我能从 `pisa.db` 里直接看到哪些外部动作在等待重试、重试了多少次、最后一次错误是什么。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `effects` 表：`(kind, key)` 主键，字段含 `task_id`、`payload`、`status`、`result`、`attempts`、`next_at`、`last_error`、`created_at`、`updated_at` |
| FR-002 | `EffectQueue` 提供 `exec`、`flush`、`start`、`stop`、`cancelTask`；处理器按 kind 注册 |
| FR-003 | `exec` 先写行（`INSERT OR IGNORE`）再执行；同键已有 `done` 行时只返回上次结果，不再执行。推送的键含提交 sha：同一提交只推一次，续跑出的新提交重新入队 |
| FR-004 | 处理器抛错时 `attempts+1`，`next_at = now + min(2s × 2^(attempts-1), 60s)`，`last_error` 保留错误摘要 |
| FR-005 | `attempts` 达到 10 次转 `failed`（终止），不再重试，错误信息保留 |
| FR-006 | `start` 启动时立即 `flush` 一次，之后按间隔（默认 1s）执行所有到期的未完成行 |
| FR-007 | 推送、建 PR、PR/Issue 回帖三条路径改为经 `EffectQueue` 执行 |
| FR-008 | effect 完成时由 Router 写 `task_effects` 账本；PR effect 同时回填 `tasks.pr_url`。重启后的重放走同一路径 |
| FR-009 | 建 PR effect 保留认领逻辑：先 `gh pr list --head <branch>`，命中即视为完成；回帖 effect 保留隐藏标记去重 |
| FR-010 | 任务失败、取消或撤销（`rewound`）时丢弃它未完成的 effect，避免对已删除工作副本重试 |
| FR-011 | 回帖失败不改变任务终态：任务按现状成功，effect 留在队列，日志注明入队重试 |
| FR-012 | 建 PR 失败回退 `compare` 链接的既有行为不变：任务成功，effect 继续重试；成功后回填 `pr_url` |

## 5. 非目标

- 不强求非幂等外部动作的 exactly-once：只保证「先落库 + 键去重 + 动作自身幂等（认领/标记）」
- 不做多进程共享消费、不做死信人工重放入口
- 不改 web UI、不改命令语法

## 6. 验收

1. 同 `(kind, key)` 连续 `exec` 两次，处理器只被调用一次，第二次拿到首次结果
2. 处理器失败后行仍在，`attempts=1`、`next_at = now+2000`；后续退避为 2/4/8/16/32/60/60…
3. 新建 `EffectQueue`（模拟重启）、同一数据库，`flush` 能继续执行 pending 行
4. gh 故障时任务仍然 `succeeded`，effect 留在队列；恢复后 `flush` 补发回帖并写账本
5. 任务失败、取消或撤销后，它的未完成 effect 不再被执行
6. `bun test` 与 `bunx tsc --noEmit` 通过
