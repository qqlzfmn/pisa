# 020 · 实现计划

## 模块

| 文件 | 责任 |
| --- | --- |
| `prompts/manifest.json`、`prompts/**/*.md` | 内置段落与版本，提示词内容的唯一来源 |
| `src/prompts.ts` | 加载、校验、覆盖解析、渲染、列表与 diff |
| `src/adapters/omp.ts` | `buildPrompt` 只负责按固定顺序取段落并拼接 |
| `src/worker.ts` | 持有 `PromptLibrary`，传给适配器 |
| `src/config.ts` | `prompts.dir` 配置与默认值、命令清单增加 `prompts` |
| `src/router.ts` | `/pisa prompts` 命令入口，输出列表与 diff |
| `src/proactive.ts` | 默认提示词改读内置段落 |
| `src/index.ts` | 启动加载与失败退出、依赖注入 |

## 步骤

1. 提示词文件与清单 → 验证：加载后键集合、版本与正文符合预期。
2. `src/prompts.ts` 加载与校验 → 验证：未知键/坏版本/坏占位符/未登记文件/未知仓库别名各自报错。
3. 覆盖解析与优先级 → 验证：仓库覆盖 > 团队 > 内置，不存在的目录回退内置。
4. `buildPrompt` 改为取段落 → 验证：现有适配器测试通过，拼装顺序固定。
5. 配置、路由命令、主动发现、启动注入 → 验证：`/pisa prompts` 与 `diff` 输出正确，显式 prompt 仍优先。
6. 文档与示例配置 → 验证：`docs/operations.md` 与 `pisa.config.example.json` 同步。
7. 新增 `tests/prompts.test.ts` 与路由测试 → 验证：`bun test`、`bunx tsc --noEmit`。

## 风险

- 段落拆分改变提示词文本 → 用内置文件保持原文，适配器现有断言继续通过；
- 路径推导错误会把文件读成别的段落 → 键格式限定为小写点分，禁止 `..`；
- 启动校验过严影响既有用户 → 只有配置了覆盖目录时才校验覆盖内容，目录缺失不报错。
