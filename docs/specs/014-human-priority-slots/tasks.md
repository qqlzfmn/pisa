# 014 · 任务

- [x] `src/types.ts`：`Task.followUp`
- [x] `src/config.ts`：`worker.humanSlots`（默认 1）；`pisa.config.example.json` 同步
- [x] `src/store.ts`：`follow_up` 列与迁移、`nextQueued(lane)`
- [x] `src/router.ts`：`SlotKind` / `SlotState`、`active` 记录槽位、`slots()` / `slotView()` / `slotsLine()` / `queueReason()`、双车道 `fill()`、`launch(task, kind)`、`claim()`、`resume` 走追问槽位、看板槽位行与排队原因
- [x] `tests/router.test.ts`：满槽时追问执行且新任务排队、追问槽位满时第二条追问排队、看板槽位与原因、`humanSlots = 0` 共用队列；测试夹具补 `followUp` 与 `humanSlots`
- [x] `README.md`：看板四段结构与追问优先槽位说明
- [x] 验证：`bun test`、`bunx tsc --noEmit`
