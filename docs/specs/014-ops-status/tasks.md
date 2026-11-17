# 014 · 任务清单

- 输入：`plan.md`
- 验证统一用 `bun test tests/health.test.ts` 与 `bunx tsc --noEmit`

- [x] T001 测试先行：`inspect` 四种退出码 (FR-001…FR-006)
      文件：`tests/health.test.ts`
      验证: 断言先红，`code` 与问题 `key` 覆盖缺配置 / 坏部件 / 无心跳 / 正常

- [x] T002 测试先行：心跳过期与去重语义 (FR-007、FR-009、FR-013)
      文件：`tests/health.test.ts`
      验证: `utimesSync` 拨老心跳得 `1`；`shouldSpeak` 说→不说→清空→再说

- [x] T003 测试先行：CLI 退出码与静默 (FR-001、FR-008、FR-012、FR-014)
      文件：`tests/health.test.ts`
      验证: 子进程运行 `src/cli.ts status`，断言 0/1/2/3；`--alert` 正常无输出、重复异常第二次无输出

- [x] T004 实现 `src/health.ts` (FR-001…FR-013)
      验证: T001–T003 转绿

- [x] T005 实现 `src/cli.ts` 与 `package.json` 的 `bin.pisa` (FR-001、FR-012、FR-014)
      验证: `bun run src/cli.ts status; echo $?`

- [x] T006 守护进程写心跳 (FR-007)
      文件：`src/index.ts`
      验证: 启动后状态目录出现 `heartbeat`，`pisa status` 返回 `0`

- [x] T007 小时巡检接线 (FR-008)
      文件：`scripts/ops-check.sh`、`scripts/install-launchd.sh`
      验证: `bash -n` 两个脚本；手动执行 `scripts/ops-check.sh` 正常时无输出

- [x] T008 文档 (README)
      验证: 退出码表、巡检日志路径、手动验证命令与实现一致

- [x] T009 配置无法解析时归为 `3` 待配置，不崩溃 (FR-005)
      文件：`src/config.ts`、`src/health.ts`、`src/cli.ts`、`tests/health.test.ts`
      验证: `loadConfigSafe` 返回 `error`；`inspect` 只报 `config-invalid`；CLI 子进程断言退出 `3`
