# 018 · 文档食谱：领域、部署、扩展

- 状态：implemented
- 关联：016（文档地图与链接测试）、014-usage-guide（使用者文档）、001/003/005/013（术语与语义出处）

## 1. 问题

仓库只有三篇说明文档和一堆规格：新人想知道「paused 和 failed 差在哪」「升级要不要手工迁库」「怎么加一个事件源」，只能在 `docs/architecture.md` 的散文里找，或者读 `src/`。

证据（2026-11-18，本工作副本）：

- `ls docs/*.md` → `docs/architecture.md`、`docs/operations.md`、`docs/usage.md`，没有术语、部署、扩展三篇。
- `grep -rn "新增来源\|加一个\|扩展点" docs/*.md CONTRIBUTING.md README.md` 只命中 `docs/architecture.md:176` 的「## 4. 扩展点」标题，正文只有三步概述；没有任何测试步骤，也没有 Adapter 的新增步骤。
- `README.md:234` 让人「实现 `WorkerAdapter` 并注册到 `src/adapters/index.ts`」，但没说参数怎么拼、输出怎么解析、改哪个测试文件。
- `grep -rn "退出码" docs/*.md README.md CONTRIBUTING.md` 只命中 `docs/operations.md:133` 一行 CLI 退出码；守护进程启动失败的 `1`、正常关停的 `75`、Worker 子进程退出码都没有落点。
- 同一概念的写法不统一：`docs/` 里混用「工作副本 / worktree」「副作用 / effect / 账本」「任务 / 单」「触发 / 事件」。

## 2. 目标

新人按文档能在 10 分钟内回答：这个词在代码里叫什么、怎么装和升级、出错先看哪、加一个来源或适配器要改哪些文件和测试。

## 3. 用户故事

### US-1 新贡献者

作为第一次读代码的人，我在一张表里查到「阶段」「副作用」「线程键」这些词对应的代码位置与规格，不用猜。

### US-2 自部署的人

作为把 pisa 跑在自己机器上的人，我能照着复制命令完成安装、升级、重启、卸载，并在排障表里按现象找到先查什么。

### US-3 要接新入口或新 agent 的贡献者

作为要加 webhook 之外的来源、或把 `omp` 换成别的 agent 的人，我照着步骤改文件、写测试、跑验证命令，不用改 `router.ts`。

### US-4 维护者

作为维护者，文档里的退出码、适配器清单、代码路径由测试守着，代码变了文档没跟上会先红。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `docs/domain.md` 提供术语表：每条含中文词、代码标识、一句话定义、代码位置、关联文档 |
| FR-002 | 术语覆盖任务生命周期（状态、阶段、终态）、触发身份（source/threadKey/messageKey/version/payloadHash）、执行（工作副本、会话、适配器）、交付（效果、outbox、回执）四组 |
| FR-003 | `docs/deployment.md` 覆盖前置条件、安装、升级（含数据库兼容与回滚边界）、卸载，命令可直接复制 |
| FR-004 | `docs/deployment.md` 提供排障表：现象 → 先查什么 → 处理 → 依据，至少覆盖无人接单、启动即退、卡死/超时、推送/PR/回帖失败、重启后 paused、端口冲突 |
| FR-005 | `docs/deployment.md` 的退出码表同时覆盖 CLI（`0`–`5`）、守护进程（`1`、`75`）、Worker 子进程，并与 `src/cli.ts` 的 `EXIT` 一致 |
| FR-006 | `docs/extending.md` 给出加 Source 的完整步骤：身份字段、类形状、装配位置、配置项、测试用例、验证命令 |
| FR-007 | `docs/extending.md` 给出加 Adapter 的完整步骤：接口契约、参数/环境/输出解析、注册表、配置、测试用例、验证命令 |
| FR-008 | `docs/extending.md` 的适配器清单与 `src/adapters/index.ts` 的注册表一致 |
| FR-009 | `docs/architecture.md` 与三篇新文档双向互链；README 与 CONTRIBUTING 的文档地图加入三篇 |
| FR-010 | 常驻（launchd）只在一处维护：`docs/deployment.md`，`docs/operations.md` 留指针 |
| FR-011 | 顶层文档（README、CONTRIBUTING、SDD、`docs/*.md`）里所有 `bash` 代码块通过 `bash -n` |

## 5. 非目标

- 不改 Router、Worker、存储与命令行为
- 不新增用户可见能力（新来源、新适配器只是文档示例，不落地实现）
- 不翻译成英文
- 不为历史规格补文档

## 6. 验收

1. `docs/domain.md`、`docs/deployment.md`、`docs/extending.md` 存在，均从 `docs/architecture.md` 可一跳到达，且各自链回 architecture
2. `bun test tests/docs-cookbook.test.ts` 通过：退出码表 = `EXIT`、适配器清单 = `ADAPTERS`、术语里的代码路径存在、互链存在、`bash -n` 全绿
3. `bun test` 全量通过，`bunx tsc --noEmit` 无报错
4. 照 `docs/deployment.md` 的安装与升级命令，在干净副本上能起到 `[pisa] ready`
5. 照 `docs/extending.md` 的步骤新增一个假的 Source/Adapter 时，需要改的文件清单完整（评审对照 `src/index.ts`、`src/adapters/index.ts`）
