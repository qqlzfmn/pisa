# 015 · 仓库工程化外观

- 状态：implemented
- 关联：无
- 依赖：无

## 1. 问题

外部访客判断一个仓库能不能参与，看的是可参与痕迹：提交进来会不会被自动拦下、报错有没有结构、PR 要交代什么、安全漏洞往哪报、每个版本改了什么。这五样现在都没有：

- **没有 CI**：`tests/` 有 13 个测试文件，`tsc --noEmit` 也能跑，但只在开发者本地跑。PR 没有任何自动校验，红相只能靠人记得。
- **没有 Issue 模板**：bug 报告缺复现步骤、版本、触发通道，维护者要来回问两轮才能定位。
- **没有 PR 模板**：不提示跑测试，不要求写回滚方式。改动影响面与撤销方式只存在于作者脑子里。
- **没有 CONTRIBUTING**：规格驱动流程、提交规范只写在 `AGENTS.md`（面向 agent 的工作规范）。人类贡献者不知道该先改规格、测试该跑哪条命令。
- **没有 SECURITY**：pisa 以运行者的用户权限执行任意命令、没有沙箱。这个前提不写在显眼处，使用者会误判隔离强度，把不可信仓库接进来。
- **没有 CHANGELOG**：版本能力只能从 README「当前状态」和提交历史里拼，无法按时间点回溯。

## 2. 目标

- 新贡献者能在只读一份文档的情况下完成：装依赖 → 跑测试 → 提交 → 开 PR。
- 规则在使用的时刻出现：CI 拦在合并前，模板问在填表时，而不是靠人记文档。
- 安全前提与漏洞上报渠道对外可见，且不夸大防护能力。
- 每个版本的能力可按版本号回溯。

## 3. 用户故事

### US-1 贡献者的 PR 被自动校验

作为维护者，别人提 PR 时，测试与类型检查不通过就被标红，不需要我拉下来跑一遍。

- Given 一个分支带类型错误，When 推送并开 PR，Then CI 在类型检查阶段失败，PR 显示失败状态。
- Given 一个分支测试失败，When 推送并开 PR，Then CI 在测试阶段失败。
- Given 一个干净分支，When 推送并开 PR，Then 测试与类型检查两项都通过。
- Given 同一分支连续推送，Then 只有最新一次运行计入，旧运行被取消。

### US-2 报告 bug 的人一次说清

作为使用者，遇到任务失败时，按模板填完就能让维护者复现，不需要多轮追问。

- Given 任务执行失败，When 打开新建 Issue 页面，Then 只能选择 bug 或 feature 表单，不能开空白 Issue。
- Given 选择 bug 表单，Then 必填项包含现象、期望行为、复现步骤、版本、触发通道、环境；日志为选填但给出脱敏提醒。

### US-3 提 PR 的人写清验证与回滚

作为评审者，打开 PR 就能看到改了什么、为什么、验证命令与输出、出问题怎么退。

- Given 有人开 PR，Then 模板包含目的/结论、背景、方案、影响与风险（含回滚方式）、验证、检查清单六段。
- Given 作者填模板，Then 回滚方式与两条验证命令（测试、类型检查）是显式待填项，不填不会被 CI 判红但会被评审看到空白。

### US-4 新人按 CONTRIBUTING 走通开发流程

作为第一次参与的人，照文档做就能跑起来并提交一个合规的 feature。

- Given 一个干净的 clone，When 按 CONTRIBUTING 执行安装、生成配置、启动本地通道，Then 能进入 CLI 通道。
- Given 要改行为，When 按 CONTRIBUTING 的流程做，Then 知道先写 `docs/specs/<编号>-<名称>/` 下的规格，再写测试，再实现。
- Given 准备提交，When 看提交规范，Then 知道用 Conventional Commits、按显式路径暂存、不直接提交 main。

### US-5 安全前提与上报渠道可查

作为准备部署的人或发现漏洞的人，打开 SECURITY.md 就能判断能不能信、该往哪报。

- Given 有人想把源码不可信的仓库接进 `repos`，Then SECURITY.md 说明 Worker 以运行者权限执行任意命令、guard 只是尽力而为的拦截，并指向完整的能力边界文档。
- Given 有人发现漏洞，Then SECURITY.md 要求不要开公开 Issue，给出私下上报的路径与需要提供的信息。

### US-6 版本能力可回溯

作为使用者，看 CHANGELOG 就知道当前版本有哪些能力。

- Given 当前版本是 `0.1.0`，Then CHANGELOG 有 `0.1.0` 条目，按新增/变更/修复分组，并保留 `Unreleased` 段给未发布改动。
- Given 版本号被提升，Then 测试在缺少对应 CHANGELOG 条目时失败。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | push 到 main 与任意 PR 都触发 CI，依次执行依赖安装、测试、类型检查；任一步失败即整体失败；同分支新提交取消旧运行 |
| FR-002 | 依赖安装可复现：用锁文件、拒绝改写的安装方式；处理工具版本固定，不在运行侧浮动 |
| FR-003 | 提供 bug 与 feature 两个 Issue 表单，关闭空白 Issue；bug 表单必填现象、期望、复现步骤、版本、触发通道、环境 |
| FR-004 | 提供 PR 模板，含目的/结论、背景、方案、影响与风险（回滚方式）、验证（测试与类型检查）、检查清单 |
| FR-005 | CONTRIBUTING 覆盖：环境要求、本地启动、测试与类型检查命令、规格驱动开发流程与规格目录约定、分支与提交规范、代码规范要点、提交前清单、文档地图 |
| FR-006 | SECURITY 覆盖：信任边界（各入口的鉴权面）、已知不防护的面、密钥处理、漏洞上报流程与支持版本 |
| FR-007 | CHANGELOG 按版本倒序、固定分组记录，当前版本条目与 `package.json` 的 version 一致 |
| FR-008 | 同一事实只有一处来源：能力边界细节留在 `docs/usage.md`，编码规范留在 `AGENTS.md`，规格流程留在 `SDD.md`；新文档只做索引与差异说明 |

## 5. 验收

1. `.github/workflows/ci.yml` 存在，触发条件含 push 与 pull_request，步骤含 `bun install --frozen-lockfile`、`bun test`、`bunx tsc --noEmit`
2. `.github/ISSUE_TEMPLATE/` 下有 bug、feature 两个表单与 `config.yml`（关闭空白 Issue）
3. `.github/pull_request_template.md` 同时出现「回滚」与两条验证命令
4. `CONTRIBUTING.md` 出现 `bun test`、`bunx tsc --noEmit`、规格流程与 Conventional Commits
5. `SECURITY.md` 出现信任边界、`docs/usage.md` 链接、不上公开渠道的要求
6. `CHANGELOG.md` 有 `Unreleased` 与 `0.1.0` 条目，`0.1.0` 与 `package.json` 一致
7. `tests/repo-ops.test.ts` 覆盖 1–6，且新文档里的相对链接都能解析到真实文件
8. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- **CI 徽章**：徽章 URL 需要 `owner/repo`，仓库当前没有远程，任何写法都会指向不存在的地址。等配置远程后再加，不在这里塞占位符。
- **macOS 专用链路进 CI**：`scripts/install-launchd.sh` 依赖 launchd，只在本地验证。
- **发布自动化、依赖机器人、PR 体积检查**：没有需求支撑。
- **改动运行行为**：本 feature 只新增仓库文件与一个测试，不碰 Worker、Router、存储。
