# 014 · 实施计划

## D1 阶段是纯投影，不进入状态机

`src/stage.ts` 导出 `TaskStage`、`STAGE_RULES`、`deriveStage`；入参只读 `Pick<Task, "status" | "prUrl">`，无写路径。

理由（FR-003）：`status` 是唯一事实源，已有状态迁移表与副作用记账都挂在它上面；阶段只是一种展示口径，落库就会产生第二份需要同步的事实。

## D2 规则表数据化，判定顺序无关

规则是一条 `StageRule { stage, statuses, hasPr? }`，放在 `STAGE_RULES` 数组里，`deriveStage` 用 `find` 取首命中，无命中抛错。

- 互斥由数据形状保证：两条 `succeeded` 规则用 `hasPr` 二值分开，其余规则的状态集合两两不重叠。
- 完备性由测试断言：`Object.keys(ALLOWED)` 的七种状态 × PR 有无，每个组合恰好命中一条。
- 缺分支抛错（FR-001）而不是默认返回 `idle`：状态机以后加状态时，看板立刻暴露，而不是静默显示成「没人需要动」。

不写成 `if` 链的理由（FR-002）：if 链的互斥性只能靠读代码判断，顺序一改就可能出现不可达分支；数据表可以被测试穷举。

## D3 三段看板各插入一个阶段段

`statusBoard` 已在渲染三种行；阶段段紧跟任务号，格式 `任务号 · 阶段 · 仓库 · …`（FR-004）。仓库与前缀不动，外部按前缀匹配的脚本不受影响。

「汇总」行保持不变（FR-008）：中断任务仍只在汇总计数里出现，不单列成段。

## D4 `/pisa state` 走独立命令，不进菜单、不参与错拼建议

`state` 在 `COMMANDS` 里省略 `menu`，于是：

- Telegram 菜单不出现（FR-007 前半）；
- `taskGuard` 只遍历 `menu` 为真的命令，`stat` 的最近命令仍是 `status`，不会被 `state` 抢走建议（FR-007 后半）。

私聊入口单独匹配 `/state`（FR-005）：与 `/status` / `/schedules` 同处一列，不受「私聊无触发词即任务」影响，避免一次查看状态产生一条任务。

输出用 `stateView()` 组装：`now` 加逐条任务对象，字段按 FR-005 固定；任务集合 = `activeTasks()` + `recentFinished(5)`（FR-006），因此四个阶段都能在输出里出现（`paused` 只有在这里可见）。

## D5 Store 只加只读查询

`activeTasks()` 是一条只读 SQL（`status IN ('queued','running','paused')`，按 `created_at` 升序），复用现有 `recentFinished`。

不改迁移表、不新增写方法，复用 010 已有的看板查询路径，避免状态语义分叉。

## D6 测试策略

- `tests/stage.test.ts`：规则表全组合穷举 + 每个阶段一条判定 + 缺分支抛错。
- `tests/router.test.ts`：`parseCommand` 认 `state`、看板三行都带阶段、`/state` JSON 结构与字段、私聊 `/state` 建任务数为 0、`stat` 的错拼建议仍为 `status`。
- `bun test`、`bunx tsc --noEmit` 作为收口。

## 验证

见 `tasks.md` 的验收结果表。
