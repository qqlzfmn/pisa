# 014 · 任务阶段投影（stage）

- 状态：implemented
- 关联：改进项 `seed:ticket-stages`；010 看板的行格式（本规格在其行内追加阶段段）
- 依赖：010

## 1. 问题

`Task.status` 只有进程状态（`queued` / `running` / `paused` / 终态四种）。它回答「进程在干什么」，不回答「现在在等谁」：

| 现状 | 看不出的事 |
| --- | --- |
| `paused` | 进程重启留下的中断任务在等请求者决定 `resume` 还是 `cancel`，看板不列它 |
| `succeeded` | 有 PR 的成功任务等人评审，没有 PR 的成功任务已经没人需要动，两者看板上都是「成功」 |
| `queued` / `running` | 都在等工作进程（排队等槽位 / 已在执行），看板分段隐含但状态文本没写 |

看板只能靠分段和 PR 链接猜，外部脚本 `/pisa status` 之外没有任何机器可读入口。

复现（`t_run` 运行中、`t_queue` 排队、`t_paused` 中断、`t_review` 成功带 PR、`t_done` 成功无 PR）：

```
运行中
t_run · demo · 已运行 3m12s · 任务 t_run

排队（1）
t_queue · demo · 任务 t_queue

最近完成
成功 · 1m30s · demo · 任务 t_review · https://github.com/o/r/pull/7
成功 · 1m30s · demo · 任务 t_done

汇总：5 个任务 · 成功 2 · 失败 0 · 暂停 1
```

中断任务不出现；两条「成功」分不出等评审还是已收尾；`/pisa state` 被当成单英文词任务拦下，提示改写 `/status`。

## 2. 目标

- 新增派生阶段 `TaskStage`：`person/answer`、`person/review`、`working/queued`、`idle`
- 阶段只读派生，不改写、不替换 `status`，不落库（`status` 仍是唯一事实源）
- `/pisa status` 每行显示阶段；`/pisa state` 输出机器可读状态（JSON，含阶段）
- 判定规则是一张互斥且完备的表，缺分支直接报错而不是猜

## 3. 阶段语义

阶段回答「下一步等谁」：

| 阶段 | 含义 | 需要谁动 |
| --- | --- | --- |
| `person/answer` | 中断任务，等请求者决定恢复还是放弃 | 人：`resume` / `cancel` |
| `person/review` | 已交付 PR，等人评审与合并 | 人：`merge` / 评审 |
| `working/queued` | 排队等槽位，或已交给工作进程执行 | 工作进程 |
| `idle` | 没有待办：成功但无 PR、失败、取消、已撤销 | 无人 |

## 4. 规则表

`src/stage.ts` 的 `STAGE_RULES` 是唯一事实源。命中条件 = `status ∈ statuses` 且（声明了 `hasPr` 时）`prUrl` 是否为空与之一致。

| 规则 | status | hasPr | 阶段 |
| --- | --- | --- | --- |
| 1 | `paused` | — | `person/answer` |
| 2 | `succeeded` | 有 | `person/review` |
| 3 | `succeeded` | 无 | `idle` |
| 4 | `queued`、`running` | — | `working/queued` |
| 5 | `failed`、`cancelled`、`rewound` | — | `idle` |

规则条件两两互斥（两条 `succeeded` 规则由 `hasPr` 分开），覆盖全部七个状态 × PR 有无两个取值，因此判定与顺序无关；数组顺序只按「等人 → 等工位 → 空闲」排列便于阅读。

## 5. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `deriveStage(Task)` 纯函数，入参只读 `status` 与 `prUrl`，返回 `TaskStage`；无规则命中时抛错 |
| FR-002 | `STAGE_RULES` 覆盖 `TaskStatus` 全部七种状态，且任意 `(status, prUrl)` 组合恰好命中一条 |
| FR-003 | `status` 保持原值，阶段仅用于展示与导出 |
| FR-004 | `/pisa status` 三段每行在任务号后插入阶段段：`任务号 · 阶段 · 仓库 · …` |
| FR-005 | `/pisa state`（私聊可直接 `/state`）返回一行 JSON：`{"now":<毫秒>,"tasks":[…]}`，每条任务含 `id`、`status`、`stage`、`repo`、`prompt`（单行前 60 字）、`prUrl`、`createdAt`、`startedAt`、`endedAt` |
| FR-006 | `/pisa state` 覆盖全部未终态任务（`queued`/`running`/`paused`，按创建时间升序）加最近 5 条终态任务，保证每个阶段都能在输出里出现 |
| FR-007 | `state` 命令不进 Telegram 菜单、不参与单英文词错拼建议（`state` 与 `status` 太近，会抢走 `/pisa stat` 的提示） |
| FR-008 | 看板仍不单列暂停任务（沿用 010 非目标），中断任务通过汇总计数与 `/pisa state` 查看 |

## 6. 验收

1. 阶段判定：`paused → person/answer`、`succeeded + prUrl → person/review`、`succeeded 无 PR → idle`、`queued`/`running → working/queued`、`failed`/`cancelled`/`rewound → idle`
2. 全组合断言：`Object.keys(ALLOWED)` 的每个状态 × `prUrl` 有无，恰好命中一条规则
3. `/pisa status` 文本含 `working/queued`、`person/review`、`idle`
4. `/pisa state` 返回可解析 JSON，其中中断任务 `stage = person/answer`、带 PR 的成功任务 `stage = person/review`
5. `/pisa stat` 的错拼建议仍是 `status`；`/pisa state` 不建任务
6. 原有 `status` 字段、状态迁移与看板三段结构不变；`bun test` 与 `bunx tsc --noEmit` 通过

## 7. 非目标

- 阶段落库或参与状态机（阶段是投影，不是事实）
- 回执（`开始执行` / `完成` / `失败`）文案改造
- 按阶段过滤、分页、推送通知
