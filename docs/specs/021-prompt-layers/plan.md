# 021 · 实施计划

- 状态：done

## 步骤

1. `src/prompts.ts`：段落表（键、变量、内置文本、开关）、覆盖加载、三层渲染、diff 与命令输出。验证：新测试对内置文本逐字断言。
2. 接线：`config.ts` 加载 `promptsDir`、`worker.ts` 与两个 adapter 输入、`pr-review.ts` 与 `github-watcher.ts` 评审提示词、router 与 CLI 命令。验证：接线测试断言覆盖出现在 Worker 与评审提示词中。
3. `/pisa prompts` 与 `pisa prompts`：列出来源、按层 diff、`--repo`、`--json`。验证：命令输出断言与 CLI 退出码。
4. 规格与文档：本目录、`docs/architecture.md`、`docs/operations.md`、`pisa.config.example.json`。验证：与代码一致，无第二份提示词正文。
