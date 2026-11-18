# 015 · 任务

- [x] [P] `.github/workflows/ci.yml`：push(main) 与 pull_request 触发，`bun install --frozen-lockfile` → `bun test` → `bunx tsc --noEmit`，bun 固定 1.4.4（FR-001, FR-002）
      验证: `bun install --frozen-lockfile` 与两条命令本地依次执行通过
- [x] [P] `.github/ISSUE_TEMPLATE/bug_report.yml`：现象、期望行为、复现步骤、版本、触发通道、环境必填，日志选填并提示脱敏（FR-003）
- [x] [P] `.github/ISSUE_TEMPLATE/feature_request.yml`：需求、背景、方案设想（选填）、验收标准、非目标（FR-003）
- [x] [P] `.github/ISSUE_TEMPLATE/config.yml`：关闭空白 Issue（FR-003）
- [x] [P] `.github/pull_request_template.md`：六段，含回滚方式与两条验证命令（FR-004）
- [x] [P] `CONTRIBUTING.md`：环境、启动、测试命令、SDD 流程、分支与提交、代码规范要点、提交前清单、文档地图（FR-005, FR-008）
- [x] [P] `SECURITY.md`：信任边界表、已知不防护、密钥处理、上报流程、支持版本（FR-006, FR-008）
- [x] [P] `CHANGELOG.md`：`Unreleased` + `0.1.0`，固定分组（FR-007）
- [x] `README.md`：顶部挂 CI 徽章，链到 `ci.yml` 的 Actions 页面（FR-009）
      验证: 徽章地址与 GitHub 远程 `qqlzfmn/pisa` 一致；测试断言工作流文件存在、链接等于图片地址去掉 `/badge.svg`
- [x] `README.md`：开发方式段落加入 CONTRIBUTING / SECURITY / CHANGELOG 入口
- [x] `tests/repo-ops.test.ts`：15 条用例，覆盖 FR-001 至 FR-009 的验收点与四个文档的相对链接
      验证: `bun test tests/repo-ops.test.ts`（15 pass）；红相已确认（改坏 CI 命令、删掉回滚段、改错版本号、改错徽章文件名各触发一条失败）
- [x] 验证：`bun test`（232 pass，含既有用例）、`bunx tsc --noEmit`（无错误）
