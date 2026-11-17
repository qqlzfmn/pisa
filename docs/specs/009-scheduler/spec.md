# 009 · 定时任务

- 状态：implemented
- 关联：README「定时任务」；`Config.proactive.probe` 只能跑命令、失败才开单，覆盖不了「每天 9 点做固定的事」
- 依赖：无

## 1. 问题

现有入口都是「有事发生才触发」：IM 消息、PR 评论、webhook、探针失败。周期性维护动作——每周一检查依赖更新、每天早上看 CI 和未合并 PR——只能靠人记得发消息。探针可复用，但它绑定在「命令退出码非 0」上，不是排程器。

## 2. 目标

- 配置里写 cron 表达式与提示词，到点由 pisa 自己开单，走和 IM 消息完全相同的链路
- 同一分钟只投一次，进程重启、tick 重叠都不会重复开单
- 单个 job 配置写错只影响自己，其他 job 照常跑
- 能查到当前配了哪些定时任务，不用翻配置文件

## 3. 用户故事

### US-1 工作日早会前巡检

作为维护者，我配 `0 9 * * 1-5` + 「检查昨天以来的 CI 失败并修掉」，工作日 9:00（本地时区）自动开一个任务，回执发到配置的会话。

### US-2 每月 1 号清理

作为维护者，我配 `0 0 1 * *`，每月 1 号零点开单做例行清理。

### US-3 配置写错不拖累其他 job

作为维护者，我把某个 cron 写成 4 段，启动日志告警并跳过它；其余 job 照常触发。

### US-4 临时停用

作为维护者，我把某个 job 的 `enabled` 设为 `false`，它不再触发，但配置保留。

### US-5 查当前定时任务

作为维护者，我发 `/pisa schedules`（私聊 `/schedules`），看到每个 job 的 id、cron、仓库和启用状态；没配置时看到怎么配。

## 4. 需求

配置（`pisa.config.json`）：

```json
{
  "scheduler": { "chatId": "<chat id>", "userId": "<user id>" },
  "schedules": [
    { "id": "morning", "cron": "0 9 * * 1-5", "prompt": "检查 CI 失败并修复", "repo": "pisa", "enabled": true }
  ]
}
```

| ID | 需求 |
| --- | --- |
| FR-001 | `Config.scheduler` 可选，提供定时任务的发送方 `chatId` / `userId`；缺省时定时任务不启用（`schedules` 存在也一样） |
| FR-002 | `Config.schedules` 可选，每项为 `{ id, cron, prompt, repo?, enabled? }`；`enabled` 省略视为启用 |
| FR-003 | cron 为标准 5 段：分 时 日 月 周，取本地时区。每个字段支持 `*`、`*/n`、单值、逗号列表、区间 `a-b`、区间步长 `a-b/n` |
| FR-004 | 字段取值域：分 0-59、时 0-23、日 1-31、月 1-12、周 0-7；周 `7` 等同 `0`（周日）。越界、`a>b`、`*/0`、段数不对都视为非法 |
| FR-005 | 日与周同时被限定时按标准 cron 语义取「或」，任一为 `*` 时取「与」 |
| FR-006 | 每 30 秒 tick 一次；命中的 job 以 `channel="cron"`、配置的 `chatId`/`userId`、`text=prompt`、`repo=job.repo` 投递一条消息 |
| FR-007 | 幂等：投递前用 `store.claimEvent` 占位。占位 key 为 `cron-claim:<id>:<YYYY-MM-DDTHH:mm>`，投递消息的 `eventId` 为 `cron:<id>:<YYYY-MM-DDTHH:mm>`（本地时间）。两个 key 必须分开：消息的 `eventId` 会被 Router 再占位一次，用同一个 key 会把任务当成重复投递丢掉 |
| FR-008 | job 的 `id` 重复时保留第一个，后续跳过并告警；cron 非法时跳过该 job 并告警，不影响其他 job |
| FR-009 | `/pisa schedules`（中文别名 `定时`，私聊 `/schedules`）列出每个 job 的 id、cron、仓库（未配置显示「默认仓库」）、启用状态；`schedules` 为空时说明配置方式并给出示例 |
| FR-010 | 帮助文本包含 `schedules` 一行 |
| FR-011 | 定时任务纳入 shutdown：进程退出时停止 tick |

## 5. 验收

1. `parseCron`：`* * * * *` 对任意时刻命中；`0 9 * * 1-5` 周一 09:00 命中、09:01 不命中、周日 09:00 不命中；`*/15 * * * *` 在第 0/15/30/45 分命中、第 7 分不命中；`0 0 1 * *` 在 1 号 00:00 命中、2 号不命中
2. 非法表达式（段数不对、越界、`*/0`、区间倒置、非数字）返回 `null`；`matches` 对非法表达式返回 `false`
3. 周字段写 `7` 时周日命中
4. 同一分钟 tick 两次只投递一条；下一分钟再投递
5. `enabled: false` 的 job 不投递
6. `repo` 透传到投递消息
7. 一个 job cron 非法时，另一个合法 job 仍然投递
8. `id` 重复时只投递一次（第一个生效）
9. `bun test` 与 `tsc --noEmit` 通过

## 6. 非目标

- 秒级 cron、`@daily` 之类的别名、`L`/`W`/`#` 等扩展语法
- 错过的分钟补偿（进程停机期间不补跑）
- 单个 job 的时区配置，统一用进程本地时区
- 通过 IM 增删改定时任务（只读展示）
- 定时任务与探针、webhook 共享配置结构
