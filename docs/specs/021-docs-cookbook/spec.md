# 021 · 贡献者文档（领域模型 / 部署排障 / 扩展指南）

- 状态：implemented
- 关联：`docs/domain.md`、`docs/deployment.md`、`docs/extending.md`、`docs/architecture.md`、`tests/docs-cookbook.test.ts`

## 1. 问题

新贡献者只有 README 与 `docs/specs/`：README 讲产品与 30 秒上手，spec 讲单个 feature 的需求与决定，`docs/architecture.md` 只给分层与约束。三件事没有落点：

- 代码与讨论里的名词（任务、触发身份、阶段、账本、对账、续跑、撤销）没有统一定义，读 spec 时要靠猜。
- 装、升级、重启、排障、退出码散在 README、`docs/operations.md`、`scripts/` 与 `src/cli.ts` 的注释里，运维时拼不出来。
- 加一个事件来源（Source）或换一个 agent（Adapter）只有架构文档里一句「三步」，没有完整步骤、配置项与要补的测试。

复现：`ls docs` 只有 `architecture.md`、`operations.md`、`usage.md`；`grep -rn "docs/domain.md\|docs/deployment.md\|docs/extending.md" .` 无结果。

## 2. 需求

- FR-001 `docs/domain.md` 提供术语表：每个词给定义、边界（易混词）与代码位置。
- FR-002 `docs/deployment.md` 覆盖安装、升级、卸载、常驻、端口与数据位置、退出码表、排障表；所有命令可直接复制执行。
- FR-003 `docs/extending.md` 给出加 Source（`TriggerAdapter` 与 `src/triggers/`）与加 Adapter（`WorkerAdapter` 与 `src/adapters/`）的完整步骤：接口、实现、装配、配置、测试、验证命令。
- FR-004 三份文档与 `docs/architecture.md` 互链；`architecture.md` 的索引与 README、CONTRIBUTING 的文档地图指向它们。
- FR-005 文档里引用的仓库路径必须存在；退出码表必须与 `src/cli.ts` 的 `helpText()` 一致。这两项由测试守护。
- FR-006 文档不复述实现：只给位置、约束与决策，代码是唯一事实源。

## 3. 非目标

- 不新增运行时功能，不改 CLI、配置项与退出码语义。
- 不把 spec 内容搬进新文档；新文档只做索引与操作说明。
- 不写面向终端用户的营销内容（README 已覆盖）。
- 不做英文版。

## 4. 验收

1. `docs/domain.md`、`docs/deployment.md`、`docs/extending.md` 存在，且 `docs/architecture.md` 链接到三者；三者各自链接回 `docs/architecture.md`。
2. `docs/deployment.md` 的退出码表与 `src/cli.ts` 的 `helpText()` 输出一致（码值与含义）。
3. `docs/deployment.md` 的排障表覆盖：启动即退出、端口占用、任务卡住、触发器 401/403/503、`gh` 缺失、launchd 未加载、SQLite 锁。
4. `docs/extending.md` 中「加 Source」「加 Adapter」各有可执行的步骤清单与测试清单，包含 `bun test` 与 `bunx tsc --noEmit` 命令。
5. 三份文档里反引号引用的 `src/`、`scripts/`、`docs/`、`extensions/` 路径全部存在（测试校验）。
6. `bun test` 与 `bunx tsc --noEmit` 通过。
