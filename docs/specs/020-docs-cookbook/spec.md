# 020 · 文档手册：领域模型、部署排障、扩展指南

- 状态：implemented
- 关联：016-readme-landing（文档入口分层）、019-trigger-adapters（Source/Adapter 契约）、014-usage-guide（命令与边界）

## 1. 问题

仓库只有三份成品文档：`README.md`（首页）、`docs/architecture.md`（内部结构）、`docs/operations.md`（配置手册）、`docs/usage.md`（场景与边界），外加 `docs/specs/`。三类读者缺页：

- **新贡献者**看不懂任务、触发器、线程、阶段、账本这些词在代码里指什么；`architecture.md` 用它们讲结构，但假设读者已经知道。
- **运维**要装、要升级、要排障时，只能从 `operations.md` 的配置章节和 `usage.md` 的「任务卡住了怎么办」里拼；没有退出码的完整清单，没有「症状 → 先看哪里 → 怎么处理」的表。
- **想加来源或换 agent 的人**只有 `architecture.md` §4.1/4.2 的接口摘要和一句「三步」，没有落点文件清单、没有配置接线、没有测试写法。

证据（`main` 当前状态）：

- `ls docs` 只有 `architecture.md`、`operations.md`、`usage.md`、`specs/`、`assets/`；不存在 `domain.md`、`deployment.md`、`extending.md`。
- `grep -rn "extending\|domain.md\|deployment" --include=*.md .` 无任何命中，README 的「文档地图」也不含这三类内容。
- `CONTRIBUTING.md` 没有「加来源 / 加适配器」的条目；`architecture.md` §4.2 只给 `TriggerAdapter` 接口和「实现三段 + 加一条路径」，未给测试与配置接线。

## 2. 目标

- 贡献者用一个词表把代码符号与领域概念对上，不再靠猜。
- 运维拿到一份可复制执行的安装/升级/排障文档，退出码一次看全。
- 新增触发源或 Worker 适配器时，照着步骤就能完成实现、装配、测试与文档同步。
- 三份文档与 `architecture.md`、`README.md` 互链，形成可导航的文档图；文档里的关键事实由测试盯住，避免漂移。

## 3. 用户故事

### US-1 新贡献者读代码

作为第一次读 `src/router.ts` 的人，我遇到 `threadKey`、`版本`、`副作用账本`、`阶段` 这些词时，能在术语表里查到定义、代码位置和它约束的行为，不必逐个反查实现。

### US-2 运维安装与升级

作为在自己机器上部署的人，我能从零复制安装命令跑起服务；升级时知道要 `git pull`、重装依赖、跑测试、重启常驻项，并且知道数据库会自动迁移、旧版本可以回退。

### US-3 运维排障

作为服务出问题的人，我按现象（任务一直排队、卡死、PR 没建、webhook 403、`/health` 503）找到对应检查点和处理动作；需要脚本分支时能查到每个退出码的语义。

### US-4 加一个事件来源

作为要接新平台的贡献者，我按步骤写出 `TriggerAdapter`、接进 HTTP 路由或常驻循环、补配置与文档，并写出覆盖验签/归一化/去重的测试。

### US-5 换一个执行器

作为要接另一个 agent CLI 的贡献者，我按步骤实现 `WorkerAdapter`、注册、选配置，并写出参数、环境、输出解析的测试；知道续跑与命令拦截在什么条件下才成立。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `docs/domain.md`：按生命周期分组的术语表，每个词给定义、代码位置与它约束的行为；覆盖全部 `TaskStatus` 与 `TaskStage` |
| FR-002 | `docs/deployment.md`：前置依赖、安装、运行方式、环境变量、常驻安装/卸载、升级与回滚、数据与备份 |
| FR-003 | `docs/deployment.md`：退出码全表（CLI 0–5、守护进程 1 与 75），每个码给触发条件与调用方应做的动作 |
| FR-004 | `docs/deployment.md`：排障表，按「症状 → 先查什么 → 处理」组织，覆盖启动失败、排队不动、卡死/超时、恢复、交付与回帖、各 HTTP 入口状态码、健康检查、磁盘 |
| FR-005 | `docs/extending.md`：新增事件来源的完整步骤——配置类型、适配器实现、路由/常驻装配、去重键约定、测试、文档同步，附可编译骨架 |
| FR-006 | `docs/extending.md`：新增 Worker 适配器的完整步骤——接口实现、注册、配置选择、续跑与拦截的成立条件、测试 |
| FR-007 | 三份新文档与 `architecture.md` 双向互链；README「文档地图」收录三份新文档 |
| FR-008 | 文档内所有命令行块可原样复制执行：不出现尖括号占位与省略号，配置用环境变量与示例文件 |
| FR-009 | 文档中的可校验事实（退出码、适配器清单、触发路由、状态与阶段词表）由测试对照代码断言，漂移即失败 |
| FR-010 | `CHANGELOG.md` 记录新增文档 |

## 5. 非目标

- 不改任务执行、触发、交付、保留任一行为；除导出测试所需的既有常量外不动代码。
- 不写英文版、不建静态站点、不引入文档生成器。
- 不把 `operations.md` 的配置项表搬进新文档；新文档只给入口链接与差异说明。
- 不承诺未实现的扩展方式（例如没有 registry 的通道装配仍按 `architecture.md` 4.3 的显式分支描述）。

## 6. 验收

1. `docs/domain.md`、`docs/deployment.md`、`docs/extending.md` 存在，且每份都链接 `./architecture.md`；`architecture.md` 链接回三份。
2. `docs/domain.md` 出现全部 7 个状态与 5 个阶段的字面量。
3. `docs/deployment.md` 的退出码集合等于 `src/cli.ts` 的 `EXIT` 值加上守护进程的 `1` 与 `75`。
4. `docs/extending.md` 的 Worker 适配器清单与 `getAdapter` 实际注册的名字一致；触发路由清单与 `src/triggers/http.ts` 的 `routes.set` 一致。
5. 三份文档的命令块不含 `<…>` 与 `...` 占位。
6. README 文档地图列出三份新文档；`tests/docs-links.test.ts` 的相对链接检查通过。
7. `bun test` 全绿，`bunx tsc --noEmit` 无报错。
