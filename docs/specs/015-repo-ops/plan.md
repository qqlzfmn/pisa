# 015 · 实施计划

## D1 CI 用 GitHub Actions，单 job

`runs-on: ubuntu-latest`，`permissions: contents: read`，`timeout-minutes: 15`，`concurrency` 按分支分组并 `cancel-in-progress: true`（FR-001）。

选 ubuntu 而不是 macOS：测试用 `mkdtemp` 建临时仓库、`git -c user.name=…` 内联身份，没有任何 macOS 依赖（唯一平台相关的 `scripts/install-launchd.sh` 不在测试范围内）；ubuntu runner 分钟数便宜一个量级。

步骤顺序固定：`bun install --frozen-lockfile` → `bun test` → `bunx tsc --noEmit`。任一步非零即失败，不做 `continue-on-error`。

## D2 固定 bun 版本

`oven-sh/setup-bun@v2` 配 `bun-version: 1.4.4`，与本地 `bun --version` 一致。浮动版本会让「本地绿、CI 红」变成版本差异排查，不是代码问题。锁定在 workflow 里，升级时改一处并同步 `@types/bun`。

`--frozen-lockfile` 保证 CI 用 `bun.lock`，安装时不改写锁文件（FR-002）。

## D3 Issue 用表单，PR 用单个 markdown 模板

Issue Form（`.github/ISSUE_TEMPLATE/*.yml`）由 GitHub 校验必填项与下拉值，比手写 markdown 模板可靠：bug 表单的必填集合与 FR-003 一一对应，`channel` 用 `dropdown` 把触发通道限定成已有通道（私聊/群聊、webhook、CLI、定时任务、GitHub 评论、其他），避免自由文本写「命令行什么的」。

`config.yml` 设 `blank_issues_enabled: false`，把用户逼到结构化的两条路径上。

不给 `contact_links`：它要求绝对 URL，仓库当前没有远程，写死了就是死链（见 spec 非目标）。等有远程再加。

PR 模板用 `.github/pull_request_template.md` 单文件：回滚方式、验证输出是自由文本，表单没有优势。段落顺序对齐 `AGENTS.md` 的 PR 规范：目的/结论 → 背景 → 方案 → 影响与风险 → 验收结果。

## D4 CHANGELOG 采用 Keep a Changelog 结构

`## [Unreleased]` 在最上，下面按版本倒序；组名固定 `新增` / `变更` / `修复`，与英文原版 Added/Changed/Fixed 对应。版本号与 `package.json` 同源：`package.json` 是 SSOT，CHANGELOG 的版本标题必须包含它（FR-007），由测试锁住。

## D5 文档分工，不重复事实

| 事实 | 唯一来源 | 其他文档怎么写 |
| --- | --- | --- |
| 沙箱/隔离/鉴权面的完整描述 | `docs/usage.md` §能力边界 | SECURITY 只给信任边界表并链接 |
| 编码规范细则 | `AGENTS.md` | CONTRIBUTING 只列要点并链接 |
| 规格流程 | `SDD.md` | CONTRIBUTING 只给执行顺序与目录约定 |
| guard 覆盖范围 | `docs/specs/014-worker-guard/spec.md` | SECURITY 声明「尽力而为」并链接 |

## D6 测试：`tests/repo-ops.test.ts` 读文本断言

不引入 YAML 解析依赖：`Bun.YAML` 存在但 `@types/bun` 未声明，为一个测试加依赖或 `as any` 都不划算（`AGENTS.md` 极简、禁止 any）。断言用正则锁定验收面：

- CI：触发条件两种、三条命令、`--frozen-lockfile`、固定 `bun-version`
- 模板：bug 表单必填标签集合、feature 表单含验收标准、PR 模板同时含「回滚」与两条验证命令
- 文档：CONTRIBUTING 含两条命令与流程关键词；SECURITY 含信任边界与 `docs/usage.md`
- 版本：CHANGELOG 含 `Unreleased` 与 `package.json` 的版本号
- 链接：`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、`README.md` 里的相对链接全部解析到真实文件

最后一条是真正的回归价值：文档链接最容易在目录重命名后腐烂，CI 每次都会抓到。

## D7 不改运行代码

本 feature 不碰 `src/`、`extensions/`。`bun test` 的既有 197 条用例必须保持通过，新增测试与它们同进程跑。
