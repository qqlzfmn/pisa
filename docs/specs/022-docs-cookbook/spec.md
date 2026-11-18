# 022 文档：领域模型、部署排障与扩展指南

- 状态：已实现
- 关联：[architecture.md](../../architecture.md)、[operations.md](../../operations.md)
- 改进项：`seed:docs-cookbook`

## 1. 问题

仓库只有 README、`docs/architecture.md`、`docs/operations.md`、`docs/usage.md` 与各特性规格。新贡献者能读到设计理由，却找不到三样东西：术语的唯一定义、从零装到能排障的操作路径、加 Source 或 Adapter 的可执行步骤。

复现：

```bash
ls docs
```

输出只有 `architecture.md`、`assets`、`operations.md`、`specs`、`usage.md`，没有 `domain.md`、`deployment.md`、`extending.md`。

```bash
grep -rn "新增触发源" README.md docs/*.md
```

只在 `docs/architecture.md:251` 命中一句话「新增触发源三步」，没有接口、配置、路由与测试步骤；Worker 适配器同样只有接口片段。退出码也没有集中表：`docs/operations.md:172` 只有一行，排障步骤散在 `docs/usage.md` 与错误文案里。

## 2. 目标

- 术语只定义一次，并指向代码落点，不在文档里复述实现。
- 部署按生命周期组织：安装、升级、回滚、退出码、排障；命令可直接复制。
- 扩展按「先定身份，再写实现，再接线，再写测试」组织，覆盖 Source 的两种形态与 WorkerAdapter。
- 三份新文档与 `architecture.md` 双向可达；README/CONTRIBUTING 的文档地图同步。

## 3. 用户故事

- US-1：新贡献者读到 PR 里的 `threadKey`、`dedupeKey`、`effect`、`stage`，能在 `domain.md` 找到定义和代码位置。
- US-2：运维在服务器上照 `deployment.md` 装好、升级、回滚，遇到报错能在排障表里定位处理方式。
- US-3：贡献者要接一个新的事件源，照 `extending.md` 写完适配器、路由、配置和测试，不需要改 Router。

## 4. 需求

| 编号 | 需求 |
| --- | --- |
| FR-001 | 新增 `docs/domain.md`，按生命周期分组给出术语、含义与代码落点；明确 `Source` 不是仓库里的类型 |
| FR-002 | 新增 `docs/deployment.md`，覆盖前置条件、首次安装、升级、回滚、CLI 与守护进程退出码、排障表、数据目录 |
| FR-003 | 新增 `docs/extending.md`，覆盖协议型 Source（`TriggerAdapter`）、常驻型 Source、`WorkerAdapter` 的完整步骤与测试 |
| FR-004 | `architecture.md` 的索引与扩展点章节链接三份新文档；新文档回链 `architecture.md` |
| FR-005 | 文档中的 bash 代码块必须通过 `bash -n`；`bun run` 的目标必须是 `package.json` 脚本或真实文件 |
| FR-006 | `docs/operations.md` 不再重复常驻与退出码细节，改为指向 `deployment.md`，保持单一真相源 |
| FR-007 | 新增 `tests/docs-cookbook.test.ts` 守护互链、术语、退出码一致性与命令可执行性 |

## 5. 非目标

- 不新增事件源或 Worker 适配器的实现，只给步骤与测试模板。
- 不改变任何运行时行为、配置默认值或错误文案。
- 不重写 `operations.md` 的配置项、命令、Web 控制台等内容。

## 6. 验收

| 项 | 判据 |
| --- | --- |
| 术语表 | `domain.md` 覆盖任务、状态、阶段、触发身份、Source、ChannelAdapter、Worker、WorkerAdapter、交付、账本、Outbox、撤销、对账、保留、主动发现 |
| 部署 | 命令可在仓库根直接执行；升级与回滚都有可回退步骤；退出码表与 `src/cli.ts` 的 `EXIT` 常量一致 |
| 扩展 | 两条 Source 路径与 WorkerAdapter 都有文件落点、接口签名、接线位置、测试文件与运行命令 |
| 互链 | `architecture.md` 能到三份新文档，三份新文档能回 `architecture.md` |
| 测试 | `bun test tests/docs-cookbook.test.ts` 通过；`bun test`、`bunx tsc --noEmit` 通过 |
