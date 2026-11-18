# 017 · 任务清单

- [x] 配置：`GithubConfig.autoMerge?: boolean`，缺省 `false`；example 配置补上字段
- [x] 编排模块：`src/auto-merge.ts`（CI 判定与轮询、PR 快照、评审提示词、verdict 解析、阻塞评论、squash 合并）
- [x] Router 接线：成功后按开关启动后台流水线；`/pisa merge` 在开关打开时委托同一流水线；`stop()` 等待进行中的合并
- [x] 评审执行：`--detach` 工作副本 + 独立 worker 会话 + 仓库 `AGENTS.md` 作为标准
- [x] 合并落账：记 `merge` 副作用（`{base}`）并清理本地分支与工作副本；`rewind` 走 PR `mergeCommit` 单提交 revert
- [x] 测试：`tests/auto-merge.test.ts` 覆盖开关关闭、CI 未绿、评审 fail、head 变化、全绿通过
- [x] 文档：README（交付层、FAQ、已知限制）、`docs/usage.md`（速查、最佳实践、边界、合并门禁）、`docs/operations.md`（配置与自举）、`docs/architecture.md`（流水线第 10 步、索引）、CHANGELOG
- [x] 验证：`bun test`（256 通过）、`bunx tsc --noEmit`（无错误）
