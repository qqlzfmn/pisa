# 贡献指南

面向人类贡献者的最短路径。给 agent 的工作规范在 [AGENTS.md](./AGENTS.md)，两者冲突时以 AGENTS.md 为准。

## 环境要求

- **bun 1.4.4**：CI 固定这个版本，本地不一致会先排查版本差异。`bun --version` 确认。
- **git ≥ 2.28**：测试用 `git init -b main` 建临时仓库。
- 可选：`gh`（GitHub 评论与 PR 链路）、`omp`（Worker 适配器，`worker.adapter` 可换）。

## 本地跑起来

```bash
bun install
cp pisa.config.example.json pisa.config.json   # 改成你的仓库路径与白名单
bun run src/index.ts --channel cli             # CLI 通道，不需要 token
```

`pisa.config.json`、`*.db`、`.pisa/` 已在 `.gitignore` 里，不要提交。相对 `stateDir` 与仓库路径都以配置文件所在目录为基准。

## 测试与类型检查

```bash
bun test                         # 全量
bun test tests/guard.test.ts     # 定向，改哪块先跑哪块
bunx tsc --noEmit                # 类型检查
```

两条都在 CI 里强制（`.github/workflows/ci.yml`，push 到 main 与任意 PR 触发）。本地绿了再推，省一轮来回。

## 开发流程

本项目用规格驱动开发（SDD），完整规则见 [SDD.md](./SDD.md)。执行顺序固定：

```
specify → plan → tasks → implement → converge
```

- 改行为之前先改规格：`docs/specs/<三位编号>-<kebab-case>/spec.md`
- `spec.md` 只写 WHAT / WHY，技术选型写 `plan.md`
- 需求带编号（`US-n` / `FR-nnn` / `NFR-nnn`），任务与测试能回溯到编号
- 先写失败的测试，再写实现
- 一个 feature 一个分支、一个 PR
- 挑编号：扫描 `docs/specs/` 取下一个空号

错别字、一行小修不用走规格流程。

## 分支与提交

- **GitHub Flow**：`main` 是稳定分支，功能分支从 main 拉出，经 PR 合回 main。不直接提交 main。
- **Conventional Commits**：`feat` / `fix` / `refactor` / `docs` / `test` / `chore`，一个提交一件事；关联 Issue 用 `fixes #N` / `closes #N`。
- **显式暂存**：`git add <path>`，不用 `git add -A` / `git add .`；提交前 `git status` 确认只带了自己的文件。
- 不改写已推送的历史；`rebase` / `amend` 只用在还没推送的本地提交上。

## 代码规范要点

完整清单在 [AGENTS.md](./AGENTS.md)。以下是评审时最常打回的几条：

- 单一真相源：同一信息只留一份，文档写索引不复述代码
- 单一函数不超过 50 行，文件超过 500 行按职责拆分
- 强类型，不用 `any`；类型声明查依赖源码，不猜
- 错误显式处理，不静默吞掉
- 依赖固定精确版本；安装依赖时忽略生命周期脚本（`bun install --ignore-scripts`）
- 删除旧代码而不是在旁边叠新版：迭代修改，不做兼容层

## 提交前检查清单

- [ ] 定向测试与 `bun test` 全量通过
- [ ] `bunx tsc --noEmit` 无错误
- [ ] 新增行为有测试；修改行为同步更新了规格与相关文档
- [ ] 面向使用者的变更写进了 [CHANGELOG.md](./CHANGELOG.md) 的 `Unreleased` 段
- [ ] 没有 token、`pisa.config.json`、数据库文件、日志

## 文档地图

| 想知道 | 看 |
| --- | --- |
| 项目是什么、怎么装、命令有哪些 | [README.md](./README.md) |
| 场景、最佳实践、能力边界（无沙箱、回滚范围、鉴权面） | [docs/usage.md](./docs/usage.md) |
| 分层、状态机、数据流、扩展点、失败模式 | [docs/architecture.md](./docs/architecture.md) |
| 规格流程 | [SDD.md](./SDD.md) |
| 工程规范（编码、测试、Git、子代理） | [AGENTS.md](./AGENTS.md) |
| 安全前提与漏洞上报 | [SECURITY.md](./SECURITY.md) |
| 版本变更 | [CHANGELOG.md](./CHANGELOG.md) |
| 每个 feature 的需求与计划 | `docs/specs/<编号>-<名称>/` |
