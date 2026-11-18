# 021 · 任务

## 规格

- [x] T001 `docs/specs/021-policy-admission/spec.md`、`plan.md`：问题复现、需求、取舍（FR-001…FR-006）

## 实现

- [x] T002 `src/policy.ts`：来源规则解析、内容哈希版本、`decide`、`recheck`、`formatPolicy`（FR-001/FR-002/FR-003/FR-004/FR-005）
- [x] T003 `src/config.ts`、`src/types.ts`：`Config.policy`、`IncomingMessage.mentioned`、`Mandate`、`Task.mandate`、`policy`/`策略` 命令（FR-001/FR-005）
- [x] T004 `src/store.ts`：`tasks.mandate` 列与旧库迁移、`admissions` 表、`recordAdmission`/`recentAdmissions`/`purgeAdmissions`（FR-003）
- [x] T005 `src/router.ts`：准入前置、observe 记录、`mandate` 落库、`/pisa policy`、resume 重校验（FR-002/FR-003/FR-004/FR-005）
- [x] T006 `src/channels/telegram.ts`、`src/triggers/feishu.ts`：`mentioned` 归一（FR-002）
- [x] T007 `src/retention.ts`、`src/status.ts`：admissions 清理、`TaskJson.mandate`（FR-003）

## 测试

- [x] T008 `tests/policy.test.ts`：四格矩阵、`off`/`observe`、版本变化、actor 来源、重校验、展示
- [x] T009 `tests/router.test.ts`、`tests/telegram.test.ts`：越权、observe、`mandate`、`/pisa policy`、降权后恢复被拒、默认策略不变
- [x] T010 `bun test`、`bunx tsc --noEmit`

## 文档

- [x] T011 `pisa.config.example.json`、`docs/architecture.md`、`docs/operations.md`、`CHANGELOG.md`
