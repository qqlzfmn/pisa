# 触发器幂等与线程归属 · 技术方案

## 结论

新增 `triggers` 表承载「入口事件 → 任务」的归属与去重；`Store.claimTrigger()` 用一个事务内的决策表回答「新建 / 重复 / 新版本」；Router 先校验再落触发器，并按结果回执或追加上下文。通道负责提供线程键。

## 数据

```sql
CREATE TABLE triggers (
  id           TEXT    NOT NULL,   -- 事件标识，等于 tasks.source
  version      INTEGER NOT NULL,   -- 正文修订序号，从 1 开始
  source       TEXT    NOT NULL,   -- 入口：telegram / github / cron / webhook / cli
  thread_key   TEXT    NOT NULL,   -- 会话标识
  actor        TEXT    NOT NULL,   -- 发起人
  at           INTEGER NOT NULL,   -- 触发时间（毫秒）
  payload_hash TEXT    NOT NULL,   -- 正文摘要
  task_id      TEXT    NOT NULL,   -- 归属任务
  PRIMARY KEY (id, version)
);
CREATE INDEX triggers_thread ON triggers(thread_key, at);
CREATE INDEX triggers_task ON triggers(task_id);
CREATE INDEX triggers_fingerprint ON triggers(thread_key, actor, payload_hash);
```

`payload_hash` 取正文折叠空白后的 sha256 前 16 位十六进制。`thread_key` 缺省为 `${channel}:${eventId}`，即事件自成线程。

## 归属决策（`Store.claimTrigger`）

输入：`id`、`source`、`threadKey`、`actor`、`payloadHash`、`at`、`newTaskId`。按顺序：

1. 存在同 `id` 的记录（取最新 `version`）：
   - `payload_hash` 相同 → `duplicate`，返回该记录的 `task_id`。
   - 不同且任务状态属于 `queued | running | paused` → 插入 `version + 1`，`kind = version`，返回同一 `task_id`。
   - 不同且任务已结束 → `duplicate`，返回该任务。避免回填摘要（由任务正文算出）与原始消息正文摘要不一致时误判为新版本。
2. 不存在同 `id` 的记录：
   - 存在同 `thread_key + actor + payload_hash` 且任务未结束的记录 → `duplicate`，返回该任务。
   - 否则插入 `version = 1`，`kind = new`，任务为 `newTaskId`。

## 线程键来源

| 入口 | thread_key |
| --- | --- |
| telegram | `telegram:<chat id>` |
| github | `github:<repo>:<pr 或 issue 号>` |
| cron | `cron:<job id>:<分钟时间戳>` |
| webhook | 请求体 `threadKey`，缺省事件自成线程 |
| cli | 事件自成线程 |

回填旧任务用同一套规则还原线程键，保证回填记录与新触发可互相归并。

## Router 流程调整

1. 校验访问白名单、仓库、正文长度、续跑命令，得到候选任务号。
2. `claimTrigger`：
   - `new` → 落任务、投递、回执（与现状一致）。
   - `duplicate` → 回执「已接单 · 任务号 + 重复触发，不新建任务」。
   - `version` → 任务排队中则更新正文并回执「已更新」；否则追加上下文并回执「已记为上下文」。
3. 回复续跑：父任务解析「消息绑定」→「同线程同发起人最近的任务」。父任务 `queued | running` 且用户未显式输入命令时，正文记为父任务上下文，不新建任务；否则按原续跑路径执行。
4. 删除 Router 对 `events` 表 `claimEvent` 的调用，去重只在触发器层。scheduler 保留自己的分钟占位（防同一 tick 重复入队），与触发器去重互不冲突。

## Store 新增接口

- `claimTrigger(input, newTaskId): TriggerClaim`
- `taskByThread(threadKey, actor): string | null`
- `appendContext(taskId, text): void`
- `updatePrompt(taskId, prompt): void`
- `triggersOf(taskId): TriggerRow[]`（测试与排查用）

## 迁移

`Store` 构造时执行一次回填：对每个尚无触发器记录的任务插入 `version = max(version) + 1` 的记录，`payload_hash = payloadHash(task.prompt)`，线程键由入口与聊天/评论信息还原。重复启动不产生重复记录。

## 测试

| 用例 | 断言 |
| --- | --- |
| 同一事件重复投递 | 任务数 1，两次都回执同一任务号，触发器 1 条 |
| 同线程同正文换个事件标识 | 任务数 1 |
| 不同线程同正文 | 任务数 2 |
| 同一事件改正文 | 任务数 1，触发器 2 条（v1、v2），排队任务正文更新 |
| 执行中任务收到编辑 | 记为上下文，正文不变 |
| 回复排队任务 | 正文进入任务上下文，不新建任务 |
| 回复已结束任务 | 走续跑，父任务号在子任务上下文里 |
| 回填 | 旧任务各有 1 条触发器记录，重复构造不翻倍 |
| thread 兜底 | 无消息绑定、同线程同发起人可续跑 |
