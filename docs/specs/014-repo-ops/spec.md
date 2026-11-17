# 014 · 仓库工程化外观

- 状态：implemented；评审结论见 `tasks.md`「评审结论」
- 关联：SDD.md（规格流程）、AGENTS.md（提交规范与质量要求）
- 依赖：无

## 1. 问题

仓库只有源码、规格和 README。外人看不到三件事：

- 改动会不会坏：没有 CI，`bun test` / `tsc` 只在本地跑，PR 上看不到结果
- 怎么提、怎么改：没有 Issue / PR 模板，没有 CONTRIBUTING，不知道从哪一步开始
- 出了问题找谁：没有 SECURITY，漏洞没有不公开的上报通道；没有 CHANGELOG，不知道某个版本包含什么

## 2. 目标

- push 与 PR 自动跑测试和类型检查，结果可见、失败即拦
- 新开 Issue 与 PR 时由模板要求补齐复现信息、验证方式和回滚方式
- 新人按 CONTRIBUTING 能装好、跑起来、按项目流程提 PR
- 安全边界写在 SECURITY，漏洞有私密上报通道
- 版本变更按版本记录在 CHANGELOG

## 3. 用户故事

### US-1 提交即验证

作为提交者，我 push 或开 PR 后，CI 自动跑 `bun test` 与 `bunx tsc --noEmit`，失败时我能直接看到是哪一步红。

### US-2 Issue 有必填信息

作为维护者，我收到的 bug 报告有复现步骤、期望结果、实际结果、环境；功能建议有要解决的问题和期望效果，不用来回复问。

### US-3 PR 写清影响与回滚

作为评审者，我能从 PR 正文看到目的、背景、方案、影响与风险、回滚方式、实际验证结果。

### US-4 上手有路径

作为新成员，我按 CONTRIBUTING 里列出的命令能在本地跑通测试，知道改动要先补 `docs/specs` 下的规格，知道提交信息格式。

### US-5 漏洞私下上报

作为发现漏洞的人，我在 SECURITY 里找到私密上报方式，也知道哪些行为算越界（哪些是本项目保证的，哪些是使用方责任）。

### US-6 版本可追溯

作为使用方，我在 CHANGELOG 里查到某个版本包含哪些能力，未发布改动在 `Unreleased` 下。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 新增 CI 工作流：`push` 与 `pull_request` 触发，依次执行 `bun install --frozen-lockfile`、`bun test`、`bunx tsc --noEmit`；任一步非零退出则 job 失败 |
| FR-002 | CI 的 bun 版本与本地开发版本一致（1.4.4） |
| FR-003 | 新增 bug Issue 表单，必填：复现步骤、期望结果、实际结果、环境、影响范围 |
| FR-004 | 新增 feature Issue 表单，必填：要解决的问题、期望效果、影响范围 |
| FR-005 | bug 表单要求提交者确认已删除日志中的 token、chat id 等敏感信息 |
| FR-006 | 新增 PR 模板，含目的、背景、方案、影响与风险（含回滚方式）、验证结果与自查清单 |
| FR-007 | 新增 CONTRIBUTING：环境要求、启动方式、常用命令、规格驱动流程、分支与提交规范、PR 前必跑检查、禁止提交的文件 |
| FR-008 | 新增 SECURITY：信任边界（谁能触发任务、Agent 的执行权限、密钥位置、日志脱敏的覆盖范围）、漏洞上报通道、范围界定 |
| FR-009 | 新增 CHANGELOG：按版本记录用户可见变化，未发布改动归入 `Unreleased`，初始版本 0.1.0 记录已实现能力 |
| FR-010 | README 增加指向 CONTRIBUTING 与 SECURITY 的入口，并去掉会随测试数量漂移的硬编码计数 |

## 5. 验收

1. Given 任意分支 push 或开 PR，When CI 运行，Then 日志包含 `bun test` 与 `bunx tsc --noEmit` 两步结果；把测试改成失败时 job 变红
2. Given 新建 Issue，When 选择模板，Then 可选「Bug 报告」「功能建议」两类；必填项留空无法提交
3. Given 新建 PR，When 打开正文，Then 自动带出模板，且包含「验证」与「回滚」
4. Given 只有 bun 与仓库副本，When 逐条执行 CONTRIBUTING 里的命令，Then 全部成功
5. Given 读完 SECURITY，When 判断责任边界，Then 能回答：Agent 以什么身份执行、哪些入口需要鉴权、密钥存在哪里、如何私下上报
6. Given 打开 CHANGELOG，When 找某个能力，Then 它在对应版本条目下；未发布的改动在 `Unreleased`

## 6. 非目标

- 覆盖率门槛、多平台矩阵（macOS / Windows）、release 自动发布、npm 发包
- CI 状态徽章：徽章 URL 需要远程仓库 `owner/repo`，当前仓库未配置远程，无法确定，不写死猜测地址
- Issue 模板的 labels / assignees / 项目看板字段：依赖仓库侧设置，模板不预置
- LICENSE 声明
- 运行时代码与现有测试的行为不变
