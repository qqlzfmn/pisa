# 017 · 任务阶段投影

- 状态：implemented
- 关联：010-status-board（看板）、015-web-console（控制台与任务 JSON）

## 1. 问题

任务的 `status` 只描述进程走到哪一步：`queued` / `running` / `paused` / `succeeded` / `failed` / `cancelled` / `rewound`。它回答不了「现在在等谁、需要什么」：

- `paused` 是等人 `resume` 或 `cancel`；
- `succeeded` 且已有分支/PR 是等人评审或 `merge`；
- `queued` 是等 worker 空闲槽位；
- `running` 是 worker 正在做；
- `failed` 没有自动重试，同样等人处理。

这些判断目前散落在看板、回执和读者的脑子里，同一个 `succeeded` 既可能表示「等你评审」，也可能表示「已经没事了」，只能靠分支/PR 字段猜。

证据（改动前的代码）：`src/status.ts` 的 `TaskJson` 只有 `status`，`formatStatusBoard` 的三段行只拼状态与耗时；`src/web.ts` 的 `BoardTask` 只额外映射 `statusLabel`。因此所有入口都拿不到统一的阶段结论。

## 2. 目标

- 从任务现有字段派生一个阶段，直接回答在等谁
- 派生只读，不写库、不改变 `status`，不新增状态跃迁
- CLI 看板、任务 JSON、Web 控制台使用同一张规则表
- 规则互斥且覆盖全部状态，并有测试逐个锁定

## 3. 用户故事

### US-1 看板读者

作为看板读者，我在 `运行中 / 排队 / 最近完成` 三段里直接看到 `person/review（等你评审）` 这类阶段，不用再对照状态和 PR 字段推断。

### US-2 脚本调用者

作为调用 `pisa status --json` 或 `/api/tasks` 的脚本，我拿到稳定的 `stage` 与 `stageLabel` 字段，同时原有 `status` 保持不变。

### US-3 维护者

作为维护者，我新增或调整状态时，阶段规则表有测试提示我补分支，不会让某个状态悄悄落进错误阶段。

## 4. 需求

阶段是 `Task` 的纯派生值，输入仅 `status`、`branch`、`prUrl`。规则表从上到下读取，第一条命中生效；各行条件互斥，并覆盖全部 `TaskStatus`。

| 顺序 | stage | 条件 | 中文 | 在等谁 |
| --- | --- | --- | --- | --- |
| 1 | `person/answer` | `status` 为 `paused` 或 `failed` | 等你处理 | 人：恢复、取消或处理失败 |
| 2 | `person/review` | `status` 为 `succeeded` 且 `branch` 或 `prUrl` 非空 | 等你评审 | 人：评审并合并 |
| 3 | `working/queued` | `status` 为 `queued` | 等空闲槽位 | worker：并发槽位释放 |
| 4 | `working` | `status` 为 `running` | 执行中 | worker：正在执行 |
| 5 | `idle` | `cancelled` / `rewound`，或 `succeeded` 且没有分支和 PR | 无待办 | 无 |

`failed` 归入 `person/answer`：pisa 没有自动重试，失败任务不会自行前进，需要人决定继续或收尾。`working` 虽未出现在改进项标题的四个名字里，但 `running` 必须有一个如实描述「worker 正在做」的阶段，否则会误落到 `idle`。

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 `src/stage.ts`，导出 `TaskStage`、`STAGE_RULES`、`STAGE_LABEL` 与 `taskStage()`；`taskStage` 只读输入，不修改任务 |
| FR-002 | `TaskJson` 增加 `stage` 与 `stageLabel`；`status`、`statusLabel` 及原有字段不变 |
| FR-003 | `/pisa status` 的每个任务行在仓库前显示 `stage（中文）`；排队与最近完成同样显示 |
| FR-004 | `pisa show` 的人类可读输出增加「阶段」一行 |
| FR-005 | Web 控制台三张表的「状态」后增加「阶段」列，详情面板增加「阶段」；数据来自 `/api/tasks` 与 `/api/tasks/<id>` 的同一投影 |
| FR-006 | 规则表必须覆盖 `src/types.ts` 中 `ALLOWED` 的全部状态；任一输入只能命中一条规则；未命中视为编程错误 |
| FR-007 | 阶段不写库、不参与状态机、不影响 `cancel` / `resume` / `merge` / `rewind` 的判定 |

看板分组沿用 010：运行中 / 排队 / 最近完成，暂停任务仍只在汇总里计数。暂停任务的 `person/answer` 阶段通过 `pisa show <id>` 或 `/api/tasks/<id>` 查看；本次不新增看板分组。

本文所称「state」指任务 JSON 投影 `TaskJson`：CLI 的 `status --json` / `show --json` / `list --json`，以及 Web 的 `/api/tasks`、`/api/tasks/<id>`。pisa 没有独立的 `/state` 路由。

## 5. 验收

1. `pisa status --json` 中每个任务同时有原 `status` 与派生 `stage`；`status` 与数据库一致
2. `pisa status` 人类输出出现 `working（执行中）`、`working/queued（等空闲槽位）`、`person/review（等你评审）` 等阶段
3. `/api/tasks` 与 `/api/tasks/<id>` 返回 `stage` / `stageLabel`；Web 表格与详情可见
4. `tests/stage.test.ts` 逐条覆盖五个阶段：排队、运行、暂停、成功有分支、成功只有 PR、成功无交付、失败、取消、撤销
5. 测试用 `ALLOWED` 的全部状态 × 有无分支 × 有无 PR 遍历，断言每次恰好命中一条规则
6. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 不新增任务状态或状态跃迁，不改 SQLite 表结构
- 不按阶段自动执行动作（如自动 merge、自动重试失败任务）
- 不改变 IM 回执文案与任务完成通知
- 不增加按阶段筛选、阶段计数或阶段耗时统计
