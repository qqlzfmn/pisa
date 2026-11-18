# 019 · 任务

- [x] `docs/specs/019-ops-status/spec.md`：口径、需求与验收
- [x] `src/ops.ts`：`opsHealth()`、`patrolTick()`、`formatOpsHealth()`、`formatOpsAlert()`、`OPS_META_KEY`
- [x] `src/config.ts`：`patrol?: { chatId?: string }`
- [x] `src/cli.ts`：`status` 打印健康块并按健康码退出；新增 `patrol`；配置文件缺失时 `status`/`patrol` 返回 3；Telegram 告警投递
- [x] `scripts/patrol.sh`、`scripts/install-launchd.sh`：每小时巡检任务
- [x] `tests/ops.test.ts`：四种码、优先级、去重、恢复清零、告警只发一次
- [x] `tests/cli.test.ts`：status / patrol 的退出码、静默与 JSON 字段
- [x] `docs/operations.md`、`skills/pisa/references/commands.md`、`skills/pisa/SKILL.md`、`pisa.config.example.json`、`CHANGELOG.md`：退出码契约与巡检用法
- [x] 验证：`bun test`、`bunx tsc --noEmit`
