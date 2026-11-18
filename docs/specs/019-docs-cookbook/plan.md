# 019 · 实施计划

## 1. 结构

| 文档 | 回答 | 不写 |
| --- | --- | --- |
| `docs/domain.md` | 这个词指什么、代码在哪、容易和什么混 | 状态跃迁细节、数据流步骤 |
| `docs/deployment.md` | 怎么装、怎么常驻、怎么升级回滚、坏了看哪里 | 配置项全量、命令语义 |
| `docs/extending.md` | 加事件源 / 加适配器改哪些文件、怎么测 | 通用架构说明 |
| `docs/architecture.md` | 分层、状态机、数据流、扩展点契约 | 安装与操作步骤 |
| `docs/operations.md` | 配置定位、全部配置项、命令、入口、保留 | 安装步骤、launchd 细节、退出码表 |

单一真相源：安装、常驻、升级、退出码只写在 `deployment.md`；operations 的对应段落改为链接。事件源与适配器的步骤只写在 `extending.md`；architecture 4.1/4.2 保留契约，链接到步骤。

## 2. 关键取舍

| 决策 | 备选 | 理由 |
| --- | --- | --- |
| 术语表按生命周期分组，不按字母排序 | 字母表 | 读者是顺着任务生命周期查词，分组能给出上下文；字母表适合已有词汇量的人 |
| 排障表用「现象 → 先看 → 处置」三列 | 按模块罗列故障 | 故障现场只有现象；三列直接映射到可执行动作 |
| 退出码表首列写成 `` `0`（`ok`） `` | 只写数字 | 测试能同时校验语义键与数值，数值与语义对调会被抓住 |
| 新增 `tests/docs-cookbook.test.ts` 解析文档 | 直接导出常量给人看 | 文档漂移只有测试能拦住；解析表格与接口块的成本低于手工同步 |
| 锚点校验从 README 扩到全仓 | 只校验新文档 | 新文档依赖 `deployment.md#退出码` 这类跨文件锚点；顺手覆盖既有文档，成本是同一个函数 |
| 不为测试导出 `buildPrompt` 以外的运行时符号，只导出 `EXIT` | 解析 `cli.ts` 源码 | `EXIT` 是文档表格的事实源，导出后测试用类型化比较，避免正则依赖格式 |

## 3. 事实来源

- CLI 退出码与语义：`src/cli.ts` 的 `EXIT`；`waitTask` 的终态映射
- 守护进程退出：`src/index.ts` 的启动错误 `exit(1)`、关停 `exit(75)`；`src/router.ts` 自举重启 `exit(1)`；`scripts/supervise.sh` 的退避与 0 退出
- 适配器接口：`src/adapters/types.ts`；注册表 `src/adapters/index.ts`；omp 的参数与环境 `src/adapters/omp.ts`
- 事件源模式：`src/scheduler.ts`、`src/proactive.ts`、`src/github-watcher.ts`；身份计算 `src/trigger.ts`
- 任务失败文案：`src/worker.ts`（超时、卡死、退出码）、`src/deliver.ts`（提交/推送/PR）、`src/router.ts`（白名单、合并门禁）
- 常驻标签与路径：`scripts/install-launchd.sh`、`scripts/supervise.sh`
- 健康判活：`src/status.ts` 的 `HEARTBEAT_STALE_MS = 10_000`

## 4. 测试策略

1. `deployment.md` 的退出码表与 `EXIT` 逐项相等；多一行、少一行、数值对调都失败
2. `extending.md` 的 `WorkerAdapter` 代码块成员集合等于 `src/adapters/types.ts` 的接口成员
3. 三份新文档里反引号引用的 `src|extensions|scripts|docs` 路径都存在
4. `architecture.md` 链接三份新文档，三份新文档回链
5. `deployment.md` 的 launchd 标签与日志路径出现在安装脚本里
6. 全仓 Markdown 的相对链接锚点落在目标文件的真实标题上

## 5. 风险

- **文档与代码语义漂移**：测试只能守住结构化事实（退出码、接口、路径、锚点），守不住「为什么」。排障条目来自实际错误文案，每行可 grep 到源码
- **命令不可执行**：安装与升级命令依赖 GitHub 地址、launchd、本机 token，CI 不跑；改用 `bash -n` 校验语法，真实执行留给人工安装
- **operations 内容迁移引发死链**：移动 launchd 段后同步目录与全仓链接，锚点测试兜底
