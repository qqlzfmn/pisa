# 019 · 文档手册：领域模型、部署排障、扩展指南

- 状态：implemented
- 关联：016-readme-landing（文档分层）、014-usage-guide（能力边界与卡住排查）、018-health-metrics（`/health` 判活）

## 1. 问题

新贡献者不知道词汇对应哪段代码，也不知道加事件源、加 WorkerAdapter 要改哪些文件、怎么验证。部署与排障信息分散在三处：README 的 30 秒上手、`docs/operations.md` 的安装与 launchd、`CONTRIBUTING.md` 的环境要求；退出码只在 operations 里以一行列出，没有「现象 → 证据 → 处置」的入口。

证据：

- `docs/` 只有 `architecture.md`、`operations.md`、`usage.md`，没有领域模型、部署、扩展文档
- `architecture.md` 4.1/4.2 只给接口与三条接入要求，没有示例、测试写法与验证命令
- `grep -n "退出码" docs/*.md` 只命中 `operations.md` 的一行；守护进程退出码 75 只写在 architecture 的恢复语义里

## 2. 目标

- 三份文档各回答一个问题：词是什么、怎么装怎么修、怎么加东西
- 术语与步骤都指向代码位置，不复述实现；与 `architecture.md` 互链
- 命令块可以直接复制执行，只有任务号这类运行时值留占位符
- 文档与代码的契约由测试守住：CLI 退出码、`WorkerAdapter` 接口、引用路径、页内锚点

## 3. 用户故事

### US-1 新贡献者

作为第一次读代码的人，我在术语表里查到一个词，能立刻跳到自己要改的文件；按扩展指南能走完「加事件源 / 加适配器 → 写测试 → 跑验证」。

### US-2 运维

作为部署的人，我在一份文档里完成安装、常驻、升级、回滚；服务或任务失败时，按排障表的「现象」找到要看的日志与要执行的动作。

### US-3 维护者

作为维护者，我改了 `EXIT` 或 `WorkerAdapter` 却忘改文档，测试会失败；文档互链的锚点失效也会被拦住。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | `docs/domain.md` 术语表：按生命周期分组，每词给定义、代码位置与易混点 |
| FR-002 | `docs/deployment.md`：前置条件、安装、启动自检、launchd 常驻、升级、回滚 |
| FR-003 | `docs/deployment.md` 排障表：现象、先看什么、处置，覆盖启动、入口、任务、合并、后台轮询 |
| FR-004 | `docs/deployment.md` 退出码：CLI 六个语义值、守护进程 0/1/75、Worker 退出码的归宿 |
| FR-005 | `docs/extending.md`：加事件源的完整步骤（身份、实现、装配、节流、测试、验证） |
| FR-006 | `docs/extending.md`：加 WorkerAdapter 的完整步骤（接口、注册、配置、测试、续跑与拦截边界） |
| FR-007 | 三份文档与 `architecture.md` 互链；README、CONTRIBUTING、operations、usage 的入口同步 |
| FR-008 | 测试校验：退出码表等于 `EXIT`、接口成员等于 `src/adapters/types.ts`、引用的仓库路径存在、全仓 Markdown 锚点可解析 |

## 5. 非目标

- 不改运行时行为；只为测试导出 `EXIT`
- 不写英文版，不提供未验证的 Linux systemd 单元
- 不复制 architecture 的状态机、数据流细节，只给指针

## 6. 验收

1. `docs/domain.md` 存在，术语按「任务与状态 / 触发与身份 / 执行与隔离 / 交付与收尾」分组，每组至少 5 个词，每个词有代码位置
2. `docs/deployment.md` 存在，安装、常驻、升级、回滚、排障表、退出码齐备
3. `docs/extending.md` 存在，加事件源与加适配器各有一份可执行的测试样例与验证命令
4. `docs/architecture.md` 在引言、4.1、4.2、5.1 与索引表链接三份新文档；三份新文档回链 architecture
5. README、CONTRIBUTING 的文档地图与 operations 的部署/退出码入口指向新文档，不重复内容
6. 新增测试在删除/篡改文档对应内容时失败，恢复后通过
7. `bun test` 与 `bunx tsc --noEmit` 通过
