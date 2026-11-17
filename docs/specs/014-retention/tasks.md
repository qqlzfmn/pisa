# 014 · 任务

- [x] `src/config.ts`：`retentionDays` 与 `DEFAULT_RETENTION_DAYS = 30`
- [x] `src/store.ts`：`RETENTION_TASK_ID`、`claimEvent` 支持注入 `seenAt`、`finishedTaskIdsBefore`、`purgeEvents`（孤儿清理排除保留占位）、`pruneRetentionMarks`、`vacuum`（VACUUM + checkpoint）、`insertTask` 落盘 `started_at` / `ended_at`
- [x] `src/retention.ts`：`dayKey` / `weekKey` / `Retention`（每日清理、每周 VACUUM、幂等占位与去历史键、单文件删除失败隔离、启停与日志）
- [x] `src/log.ts`：`TaskLogger` 按大小轮转（默认 10 MiB，只保留一代 `.1`），单行超限按字符边界截断
- [x] `src/index.ts`：启动 `Retention`，shutdown 停止
- [x] `tests/retention.test.ts`：过期/未过期边界、结束时间判据、未结束任务、同日幂等、孤儿占位过期、关闭清理、自定义天数、progress 删除失败隔离、每周 VACUUM（含短保留期）、日志轮转与单行截断
- [x] `README.md`、`pisa.config.example.json`：配置与行为说明
- [x] 验证：`bun test`（142 pass）、`bunx tsc --noEmit`
