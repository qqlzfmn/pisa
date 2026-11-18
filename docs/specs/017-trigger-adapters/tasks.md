# 017 · 任务清单

## 契约与类型

- [x] T001 定义 `TriggerAdapter`、`TriggerPayload`、`TriggerOutcome`（FR-002）
  验证: `bunx tsc --noEmit`
- [x] T002 `Config` 增加 `triggers` 与三个来源配置（FR-001、FR-003）
  验证: `bunx tsc --noEmit`

## 适配器

- [x] T003 GitHub Actions：HMAC-SHA256 校验、`workflow_run` 归一化、仓库白名单（FR-005～007）
  验证: `bun test tests/triggers-github.test.ts`
- [x] T004 飞书：token 校验、AES 解密、URL 验证、消息归一化（FR-008～010）
  验证: `bun test tests/triggers-im.test.ts`
- [x] T005 企业微信：SHA1 签名、AES 解密、GET echostr、XML 归一化（FR-011～013）
  验证: `bun test tests/triggers-im.test.ts`
- [x] T006 工厂：按配置构建，缺凭据只告警（FR-003）
  验证: `bun test tests/triggers-server.test.ts`

## 集成

- [x] T007 `createTriggerHandler` 与 `startTriggerServer`（FR-004、FR-014、FR-015）
  验证: `bun test tests/triggers-server.test.ts`
- [x] T008 `src/index.ts` 装配、启动日志、关停（FR-001、FR-003）
  验证: 启动日志出现 `triggers listening`，关停后端口释放

## 验收

- [x] T009 测试覆盖：签名失败、重复事件、非法载荷、白名单
  验证: `bun test tests/triggers-github.test.ts tests/triggers-im.test.ts tests/triggers-server.test.ts`
- [x] T010 文档：operations（入口与配置）、architecture（模块表）、配置示例、CHANGELOG
  验证: `bun test tests/docs-links.test.ts tests/architecture-doc.test.ts`
- [x] T011 全量验证
  验证: `bun test`、`bunx tsc --noEmit`
