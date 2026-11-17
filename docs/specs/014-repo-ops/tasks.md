# 014 · 任务

- [x] T001 `.github/workflows/ci.yml`：push/PR 触发，install → test → typecheck，bun 1.4.4（FR-001、FR-002）
- [x] T002 `.github/ISSUE_TEMPLATE/bug_report.yml`：五项必填 + 脱敏确认（FR-003、FR-005）
- [x] T003 `.github/ISSUE_TEMPLATE/feature_request.yml` + `config.yml`：三项必填，关闭空白 Issue（FR-004）
- [x] T004 `.github/pull_request_template.md`：目的/背景/方案/影响与风险（含回滚）/验证（FR-006）
- [x] T005 `CONTRIBUTING.md`：环境、命令、SDD 流程、提交规范、PR 检查（FR-007）
- [x] T006 `SECURITY.md`：信任边界、密钥与脱敏、私密上报、范围（FR-008）
- [x] T007 `CHANGELOG.md`：`Unreleased` + 0.1.0（FR-009）
- [x] T008 `README.md`：贡献入口、去掉硬编码测试计数（FR-010）
- [x] T009 `docs/specs/014-repo-ops/`：spec / plan / tasks
- [x] 验证：`bun install --frozen-lockfile`、`bun test`、`bunx tsc --noEmit`、YAML 与 issue form 结构校验（见 plan「验证」）
