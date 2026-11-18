# 020 · 实现计划

## 1. 文档拆分（FR-001 ~ FR-006）

| 文档 | 读者问题 | 内容边界 | 不写什么 |
| --- | --- | --- | --- |
| `docs/domain.md` | 「这个词指什么」 | 术语定义、代码位置、约束 | 流程教程、配置项 |
| `docs/deployment.md` | 「怎么装、怎么升、坏了看哪」 | 命令、环境变量、退出码、排障表 | 架构说明、扩展步骤 |
| `docs/extending.md` | 「怎么加一个来源/执行器」 | 步骤、骨架、测试、文档同步清单 | 领域概念定义（链到 domain） |

三份都短于 `architecture.md`，内容为「索引 + 决策约束」，不复述代码逻辑（遵循 AGENTS.md：文档写索引指向代码）。

## 2. 事实来源（FR-009）

文档里的每个可校验事实都从代码取，不凭记忆：

| 事实 | 代码位置 | 测试断言方式 |
| --- | --- | --- |
| CLI 退出码 | `src/cli.ts` 的 `EXIT` 常量 | 测试解析 `EXIT` 块，与 `deployment.md` 表格的首列集合比较 |
| 守护进程退出码 | `src/index.ts` 的 `process.exit(1)` / `process.exit(75)` | 文档必须出现 `75` 且说明 supervisor 重启；集合比较含 `1` |
| Worker 适配器清单 | `src/adapters/index.ts` 的 `REGISTRY`，对外通过 `getAdapter` 的错误消息暴露 | 触发未知适配器，解析「可用：」后缀，逐个要求在 `extending.md` 出现 |
| 触发路由 | `src/triggers/http.ts` 的 `routes.set("/…")` | 正则取全部路径，与 `extending.md` 表格反引号路径集合相等 |
| 状态与阶段 | `src/types.ts` 的 `ALLOWED`、`src/stage.ts` 的 `STAGE_RULES` | 每个字面量必须出现在 `domain.md` |
| 命令可复制 | 无 | 三份文档的 ``` 代码块禁止 `<…>` 与 `...` |

选择解析源码而不导出新常量：`getAdapter` 的错误消息已是公开行为；`EXIT` 与 `routes.set` 用正则读取，测试文件与文档同属仓库，漂移即失败，代价可接受（与 `tests/architecture-doc.test.ts` 读 `ALLOWED` 同一思路）。

## 3. 互链（FR-007）

- `README.md` 文档地图加三行。
- `docs/architecture.md`：开头「相关文档」与 §4 扩展点各加链接。
- `docs/operations.md`：安装、常驻、退出码相关段落指向 `deployment.md`；触发适配层段落指向 `extending.md`。
- `docs/domain.md` / `deployment.md` / `extending.md` 顶部都有返回 `architecture.md`、`operations.md` 的链接。
- 链接存在性由既有 `tests/docs-links.test.ts` 覆盖，无需重复实现。

## 4. 命令可执行（FR-008）

- 文档中的命令只使用两类输入：仓库内已存在的文件（`pisa.config.example.json`、`scripts/*.sh`）与环境变量（`$PISA_TELEGRAM_TOKEN`、`$PISA_WEB_TOKEN`、`$GH_TOKEN` 等）。
- 需要用户填值的配置，用 `cat > pisa.config.json <<'JSON'` 代码块给出完整字面量，或指向 `pisa.config.example.json` 后 `jq`/编辑器修改。
- launchd 命令用 `$(id -u)`，不写 `<uid>`。

## 5. 测试策略（FR-009）

新增 `tests/docs-cookbook.test.ts`：

1. 三份文档存在，且各自含 `./architecture.md` 链接；`architecture.md` 含三份文档链接。
2. 退出码集合相等。
3. 适配器名集合包含关系（代码 → 文档）。
4. 触发路由集合相等（代码 ↔ 文档）。
5. 状态与阶段字面量覆盖。
6. 代码块占位检查。

不新增运行时代码；测试先写、先红（文档不存在时失败），再写文档转绿。

## 6. 风险

| 风险 | 处理 |
| --- | --- |
| 文档写成第二份实现说明，改代码后过期 | 只写契约与落点路径，细节指向代码与 specs；事实用测试盯 |
| 排障表与 `usage.md` 重复 | `usage.md` 保留「用户视角卡住怎么办」，`deployment.md` 只放运维动作并链接过去 |
| 骨架代码编译不过 | 骨架从 `src/triggers/github-actions.ts` 与 `src/adapters/omp.ts` 裁剪，保号签名不变 |
