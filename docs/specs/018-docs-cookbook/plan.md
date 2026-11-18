# 018 · 实施计划

## 1. 结构

三篇各管一件事，不互相复述：

| 文件 | 回答 | 不回答 |
| --- | --- | --- |
| `docs/domain.md` | 这个词在代码里叫什么、在哪 | 怎么用、怎么配 |
| `docs/deployment.md` | 怎么装、怎么升、出错查哪、退出码 | 配置项清单、IM/CLI 命令 |
| `docs/extending.md` | 加来源/适配器改哪些文件、写哪些测试 | 分层原理（链 architecture §4） |

`docs/architecture.md` 保留分层、状态机、数据流、失败模式；三篇新文档从它的「配套文档」一行进入，各自链回。README 与 CONTRIBUTING 的文档地图各补三行。

## 2. 关键取舍

| 决策 | 备选 | 理由 |
| --- | --- | --- |
| launchd 段从 `operations.md` 迁到 `deployment.md` | 两边各留一份 | 升级后要重启服务，排障要读日志，三段必须相邻；两处维护必然漂移 |
| `domain.md` 用表，不用散文 | 按概念写小节 | 读者是「查词」不是「阅读」；一行一个词才能扫 |
| 退出码表放在 `deployment.md` | 留在 `operations.md` 的命令段 | 退出码是部署与脚本接口，和 supervisor 的 `75` 属于同一件事 |
| 导出 `EXIT`、`ADAPTERS` 供测试引用 | 测试正则解析源码 | 解析源码文本把格式当契约；常量本来就是事实源，导出成本一个关键字 |
| `bash -n` 覆盖顶层 Markdown，不扫 `docs/specs/` | 全仓库 Markdown | 规格是历史记录，允许演化笔记式的伪命令；顶层文档对读者承诺「可复制」 |
| 文档代码块只写最小形状，不写完整实现 | 贴一份可编译的新 Source | 新来源/适配器是贡献者的代码，文档贴完整实现会与真实实现分叉 |

## 3. 测试策略

`tests/docs-cookbook.test.ts` 守住能枚举的事实，防漂移：

1. `deployment.md` 退出码表中 `pisa` CLI 行 = `src/cli.ts` 的 `EXIT` 值集合
2. `extending.md` 的适配器清单 = `src/adapters/index.ts` 的 `ADAPTERS`
3. `domain.md` 反引号里的 `src/`、`extensions/`、`scripts/` 路径都存在
4. architecture ↔ domain/deployment/extending 双向链接都在（只看正文，跳过代码块）
5. README、CONTRIBUTING、SDD、`docs/*.md` 的 ```bash 块逐个过 `bash -n`

已有的 `tests/docs-links.test.ts` 继续负责死链与 README 锚点；`tests/architecture-doc.test.ts` 继续负责状态跃迁表与 architecture 的代码路径。三者职责不重叠。

## 4. 事实来源

- 退出码：`src/cli.ts`（`EXIT`）、`src/index.ts`（启动失败 `1`、关停 `75`）、`scripts/supervise.sh`（非 0 退避重启）
- 安装、升级、常驻：`README.md` 30 秒上手、`scripts/install-launchd.sh`、`scripts/supervise.sh`
- 数据库升级：`src/store.ts` 的 `CREATE TABLE IF NOT EXISTS` 与 `ALTER TABLE tasks ADD COLUMN`
- 排障现象与错误文案：`src/worker.ts`（`卡死：超过 … 秒`、`执行超时（…s）`）、`src/router.ts`（PR 失败回退 compare）、`src/index.ts`（缺 token、没有启用的通道）
- 扩展契约：`src/adapters/types.ts`、`src/adapters/index.ts`、`src/index.ts` 的装配段、`docs/architecture.md` 4.1/4.2
- 进度协议：`extensions/pisa-worker.ts` 写 `session` / `tool` / `blocked` / `done`，`src/router.ts` 轮询读取

## 5. 风险

- **`bash -n` 只保证语法**：`pisa` 是否在 PATH、token 是否存在无法静态验证；文档用 `command -v` 提示，不承诺环境。
- **清单测试只覆盖可枚举事实**：退出码、适配器名、路径、链接。措辞与行为漂移仍靠评审。
- **`ADAPTERS` 导出形成新接口**：只有测试引用；若将来做插件化，它是现成的注册表读数点。

## 6. 验证

```bash
bun test tests/docs-cookbook.test.ts
bun test
bunx tsc --noEmit
```
