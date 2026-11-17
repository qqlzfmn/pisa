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

## 评审结论（2026-11-18）

**通过**。逐条对照验收 1–6：

| 标准 | 判定 | 依据 |
| --- | --- | --- |
| CI 跑 `bun test` + `bunx tsc --noEmit` | 满足（配置正确；仓库无远程，托管前不会触发，文档已如实标注） | `.github/workflows/ci.yml`；本地按同样三步跑通 |
| Issue 模板 bug / feature | 满足 | `bug_report.yml` 五项必填 + 脱敏必勾；`feature_request.yml` 三项必填；`config.yml` 关空白 Issue |
| PR 模板含测试与回滚 | 满足 | `.github/pull_request_template.md` 回滚为固定行，验证段含两条命令勾选项 |
| CONTRIBUTING 开发流程与提交规范 | 满足 | SDD 五阶段、分支流程、Conventional Commits、`git add <path>`；命令与 `package.json` scripts 一致 |
| SECURITY 信任边界与上报 | 满足 | 白名单（`src/router.ts` `checkAccess`）、webhook 回环 + token + 白名单 + 去重顺序、GitHub 评论无作者鉴权、`DENY` 非沙箱、`redact` 仅模式匹配、Advisories 私密上报 |
| CHANGELOG 按版本记录 | 满足 | `Unreleased` + `0.1.0`，与 `package.json` 版本对齐 |

评审提出的三条必修已落地：README / CONTRIBUTING 的 CI 状态改为与「未配置远程」一致的表述；SECURITY 的 webhook 行补白名单校验与去重顺序；CHANGELOG 的收录规则与条目不再冲突。

复核命令（YAML 与 issue form 结构）：

```bash
bun -e '
for (const p of [".github/ISSUE_TEMPLATE/bug_report.yml",".github/ISSUE_TEMPLATE/feature_request.yml",".github/ISSUE_TEMPLATE/config.yml",".github/workflows/ci.yml"]) {
  const v = Bun.YAML.parse(await Bun.file(p).text());
  if (p.includes("ISSUE_TEMPLATE") && p.endsWith("yml") && !p.endsWith("config.yml")) {
    const ids = v.body.map((f) => f.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw new Error(`${p}: 字段 id 重复`);
    if (!v.name || !v.description) throw new Error(`${p}: 缺 name/description`);
  }
  console.log("OK", p);
}'
```

