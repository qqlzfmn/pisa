# 019 · 任务

## 规格

- [x] T001 `docs/specs/019-trigger-adapters/spec.md`、`plan.md`：问题复现、需求、取舍（FR-001…FR-008）

## 实现

- [x] T002 `src/config.ts`：`TriggersConfig`、默认端口、文件监听路径按配置目录解析（FR-006）
- [x] T003 `src/triggers/types.ts`：`TriggerAdapter`（验证/归一化/去重键）、`TriggerError`、`dispatch`（FR-001/FR-007）
- [x] T004 `src/triggers/github-actions.ts`：HMAC-SHA256 验签、`workflow_run` 归一、仓库白名单与结论过滤（FR-002）
- [x] T005 `src/triggers/feishu.ts`：`X-Lark-Signature` 与时间窗口、challenge 回执、群/用户白名单（FR-003）
- [x] T006 `src/triggers/wecom.ts`：`msg_signature`、AES 解密、文本消息与 GET 校验（FR-004）
- [x] T007 `src/triggers/file-watch.ts`：路径白名单、去抖、`fs.watch` 源（FR-005）
- [x] T008 `src/triggers/http.ts`：单端口按路径分发、正文上限、协议回执（FR-001）
- [x] T009 `src/triggers/index.ts`、`src/index.ts`：按配置装配与关停（FR-006）

## 测试

- [x] T010 `tests/trigger-adapters.test.ts`：四个适配器的签名失败、重复事件、非法载荷、白名单越界与文件变化实跑
- [x] T011 既有用例回归：`bun test`、`bunx tsc --noEmit`

## 文档

- [x] T012 `pisa.config.example.json`、`docs/architecture.md`、`docs/operations.md`、`CHANGELOG.md`
