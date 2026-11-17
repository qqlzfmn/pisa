# 014 · 任务

- [x] `src/config.ts`：`retentionDays` 与 `DEFAULT_RETENTION_DAYS = 30`
- [x] `src/store.ts`：`claimEvent` 支持注入 `seenAt`、`finishedTaskIdsBefore`、`purgeEvents`、`vacuum`（VACUUM + checkpoint）
- [x] `src/retention.ts`：`dayKey` / `weekKey` / `Retention`（每日清理、每周 VACUUM、幂等占位、启停与日志）
- [x] `src/log.ts`：`TaskLogger` 按大小轮转（默认 10 MiB，只保留一代 `.1`）
- [x] `src/index.ts`：启动 `Retention`，shutdown 停止
- [x] `tests/retention.test.ts`：过期/未过期边界、未结束任务、同日幂等、孤儿占位过期、关闭清理、自定义天数、每周 VACUUM、日志轮转
- [x] `README.md`、`pisa.config.example.json`：配置与行为说明
- [x] 验证：`bun test`（138 pass）、`bunx tsc --noEmit`
