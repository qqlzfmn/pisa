# 014 · 任务

- [x] `src/stage.ts`：`TaskStage`、`STAGE_RULES`、`deriveStage`（FR-001、FR-002、FR-003）
- [x] `src/router.ts`：看板三段插入阶段段（FR-004）、`stateView`（FR-005、FR-006）、`state` 命令分派与私聊 `/state`（FR-007）
- [x] `src/config.ts`：`COMMANDS` 增加 `state`，不带 `menu`（FR-007）
- [x] `src/store.ts`：只读查询 `activeTasks()`（FR-006）
- [x] `tests/stage.test.ts`：全组合断言 + 各阶段判定 + 缺分支抛错
- [x] `tests/router.test.ts`：命令解析、看板文本、`/state` JSON、私聊 `/state` 不建任务、`stat` 建议不变
- [x] `README.md`：看板阶段列与 `/state` 说明
- [x] `docs/specs/010-status-board/spec.md`：行格式补充阶段段
- [x] 验证：`bun test`、`bunx tsc --noEmit`

## 验收结果

| spec §6 | 证据 | 结果 |
| --- | --- | --- |
| 1 阶段判定 | `tests/stage.test.ts` 「中断任务等人应答」「成功且交付 PR 等人评审」「成功但没有 PR 空闲」「排队与执行中都在等工作进程」「失败、取消、已撤销空闲」 | 通过 |
| 2 全组合 | `tests/stage.test.ts` 「覆盖全部状态 × PR 有无，每个组合恰好命中一条」 | 通过 |
| 3 看板文本 | `tests/router.test.ts` 看板用例断言 `working/queued`、`person/review` 与汇总行 | 通过 |
| 4 `/state` JSON | `tests/router.test.ts` 「state 视图：JSON 含阶段，覆盖中断任务」 | 通过 |
| 5 错拼与私聊 | `tests/router.test.ts`「私聊 /state 不走任务」、`taskGuard` 用例（`stat → status`） | 通过 |
| 6 回归 | `bun test` 138 通过 / 0 失败；`bunx tsc --noEmit` 无输出（退出码 0） | 通过 |
