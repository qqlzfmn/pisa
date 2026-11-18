# 018 · 任务清单

## 契约与数据

- [x] T001 定义 `HealthExit`、`HealthIssue`、`HealthReport` 与问题 key 命名（`config:*` / `effects:failed` / `daemon:down`）(FR-001, FR-002, FR-003)
      验证: `bunx tsc --noEmit`；keys 在 `tests/ops-status.test.ts` 中断言
- [x] T002 `Store` 增加 `deleteMeta` 与 `failedEffectCount` (FR-004, FR-007, NFR-001)
      验证: `bun test tests/ops-status.test.ts tests/effects.test.ts`
- [x] T003 `Config` 增加 `patrol.chatId` 并写入 `pisa.config.example.json` (FR-008)
      验证: `bun test tests/cli.test.ts`

## 健康检查

- [x] T004 [P] `src/token.ts`：环境变量 → `~/.pisa/<约定名>` 解析，与 `scripts/tokens.sh` 同表 (FR-003, NFR-004)
      验证: `tests/ops-status.test.ts` 中 telegram 缺 token 用例 + 手动 `PISA_TELEGRAM_TOKEN= bun run src/cli.ts status`
- [x] T005 `src/health.ts` 实现配置检查（仓库路径、入口、白名单、token、定时任务身份）(FR-003, NFR-003)
      验证: `bun test tests/ops-status.test.ts`
- [x] T006 `src/health.ts` 汇总 outbox 失败与心跳过期，按 3 > 2 > 1 排序输出 (FR-002, FR-004, FR-005)
      验证: `bun test tests/ops-status.test.ts`

## CLI 集成

- [x] T007 `pisa status` 返回健康码；人类输出列出问题并标出健康等级 (FR-001, FR-002)
      验证: `bun test tests/cli.test.ts tests/ops-status.test.ts`
- [x] T008 `status --json` 增加 `health.exit / label / issues` (FR-001)
      验证: `bun test tests/cli.test.ts`
- [x] T009 `pisa patrol`：正常静默、异常打印并投递、失败发送只写 stderr (FR-006, FR-008)
      验证: `bun test tests/ops-status.test.ts`
- [x] T010 `src/patrol.ts` 去重签名写入 meta，健康时清除 (FR-007)
      验证: `bun test tests/ops-status.test.ts`
- [x] T011 `helpText` 增加 patrol 与 status/patrol 退出码例外 (FR-010)
      验证: `bun run src/cli.ts --help`

## 脚本与常驻

- [x] T012 [P] 抽 `scripts/tokens.sh`，`supervise.sh` 改为 source (NFR-004)
      验证: `bash -n scripts/tokens.sh scripts/supervise.sh scripts/patrol.sh`
- [x] T013 [P] 新增 `scripts/patrol.sh`（加载 token 后执行 patrol）(FR-009)
      验证: `PISA_CONFIG=$PWD/pisa.config.json bash scripts/patrol.sh; echo $?`
- [x] T014 `install-launchd.sh` 安装 `ai.pisa.patrol`（StartInterval 3600，RunAtLoad，独立日志），重复执行幂等 (FR-009)
      验证: `bash -n scripts/install-launchd.sh`；安装后 `launchctl print gui/$UID/ai.pisa.patrol | rg StartInterval`

## 测试与文档

- [x] T015 [P] `tests/ops-status.test.ts` 覆盖四种退出码、优先级、去重、恢复清零、问题变化再提醒 (FR-001, FR-006, FR-007)
      验证: `bun test tests/ops-status.test.ts`
- [x] T016 [P] 更新 `tests/cli.test.ts` 既有 status 用例到新退出码语义 (FR-001)
      验证: `bun test tests/cli.test.ts`
- [x] T017 [P] `docs/operations.md` 新增「健康与巡检」并同步退出码与 launchd 段落 (FR-010)
      验证: `bun test tests/docs-links.test.ts`
- [x] T018 [P] 同步 `skills/pisa/SKILL.md` 与 `references/commands.md` 的 status/patrol 契约 (FR-010)
      验证: `bun test tests/architecture-doc.test.ts tests/docs-links.test.ts`

## 收敛

- [x] T019 全量回归与类型检查 (FR-001, NFR-001)
      验证: `bun test && bunx tsc --noEmit`
