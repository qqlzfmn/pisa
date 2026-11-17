# 触发器幂等与线程归属 · 任务

- [x] 规格与方案：spec.md、plan.md
- [x] 摘要与线程键工具 `src/trigger.ts`
- [x] 类型：`IncomingMessage.threadKey`
- [x] Store：`triggers` 表、`claimTrigger`、`taskByThread`、`appendContext`、`updatePrompt`、`triggersOf`、回填
- [x] Router：按触发结果回执；回复续跑线程兜底；上下文补充
- [x] 入口：telegram / github / cron / webhook 提供线程键
- [x] 测试：重复投递、同线程归并、不同线程、编辑版本、上下文、回填
- [x] README 同步
- [x] `bun test`、`bunx tsc --noEmit`
