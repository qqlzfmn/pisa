# 014 · 任务拆分

- [x] T1 复现：假 runner + 真实临时仓库，确认陌生人评论派活并 `merge` 进主干
      验证: 脚本输出「mallory 评论产生任务数: 1」「main 变化: true」
- [x] T2 `Config.github.allowedUsers` + 示例配置 (FR-001)
      验证: `bunx tsc --noEmit`；`pisa.config.example.json` 含 `allowedUsers`
- [x] T3 `GithubWatcher`：作者集合、启动 fail-closed、逐条过滤与告警、投递带 `author` (FR-002/FR-003/FR-004)
      验证: `bun test tests/github-comments.test.ts`（非白名单作者忽略、白名单作者投递、`allowedUsers` 为空不轮询）
- [x] T4 `IncomingMessage.author` / `Task.author` / `tasks.author` 列与迁移 (FR-004)
      验证: `bun test tests/github-comments.test.ts`（建库即走迁移）；`bunx tsc --noEmit`
- [x] T5 `Router` 通道收窄门禁 (FR-005/FR-006)
      验证: `bun test tests/router.test.ts`（github 通道 merge 被拒且主干不变；webhook/cron/proactive 的 cancel/resume 被拒）
- [x] T6 README 与 006 规格同步 (FR-001…FR-004)
      验证: 人工检查 README「GitHub 评论」小节与 `docs/specs/006-github-comments` 交叉引用
- [x] T7 全量验证：`bun test`、`bunx tsc --noEmit`
