# 022 · 任务

## 规格

- [x] T001 `docs/specs/022-policy-admission/spec.md`、`plan.md`：问题复现、需求、取舍（FR-001…FR-008）

## 实现

- [x] T002 `src/config.ts`：`policy.sources.<来源>` 的类型与默认配置位；`policy` 命令进 `COMMANDS`（FR-001）
- [x] T003 `src/policy.ts`：默认准入表、`resolvePolicy`（稳定序列化 + 版本）、`decide`（四格 × accept）、`formatPolicy`（FR-002/FR-005/FR-007）
- [x] T004 `src/router.ts`：构造时解析策略；建任务前判准入并回复原因与版本；任务写 mandate/`policyVersion`；resume 前重判 + `checkAccess`；`/pisa policy` 分派（FR-003/FR-004/FR-006/FR-007）
- [x] T005 `src/store.ts`：`mandate`/`policy_version` 列、旧库补列、`countActiveByPolicyVersion`（FR-004/FR-007）
- [x] T006 `src/types.ts`：`IncomingMessage.mentioned`、`TaskMandate`、`Task.mandate`/`policyVersion`（FR-003/FR-004）
- [x] T007 `src/triggers/feishu.ts`：`mentioned` 取占位符或 p2p（FR-008）

## 测试

- [x] T008 `tests/policy.test.ts`：越权拒绝、名额内放行并记凭据、未 @ 拒绝与放开、observe、off、降权后恢复被拒、策略未变恢复放行、旧任务重校验、`/pisa policy` 输出、版本稳定性
- [x] T009 `tests/trigger-adapters.test.ts`：飞书群消息 `mentioned` 有/无占位符两例；`tests/telegram.test.ts` 命令菜单加入 `policy`
- [x] T010 既有用例回归：`bun test`、`bunx tsc --noEmit`

## 文档

- [x] T011 `docs/operations.md`（来源准入一节、命令清单、GitHub 鉴权说明）、`docs/usage.md`（鉴权面与场景表）、`docs/architecture.md`（鉴权顺序）、`CHANGELOG.md`
