# 015 · 任务

- [x] `src/policy.ts`：`PolicySource` / `AcceptMode` / `AdmissionCell` / `Mandate`、`DEFAULT_CELLS`、`effectivePolicy`（归一化 + 内容哈希版本）、`decideAdmission`、`formatPolicy`
- [x] `src/types.ts`：`IncomingMessage.origin/principal/mentioned`、`Task.mandate`
- [x] `src/config.ts`：`Config.policy`、`policy` 命令（别名 `策略`，查询组，进菜单）
- [x] `src/store.ts`：`tasks.mandate` 列与旧库补列、`insertTask` / `toTask` 映射、坏数据兜底
- [x] `src/router.ts`：`admit` / `checkAccess` 拆分、`mandate` 落库、`observe` 回执、`/pisa policy`、私聊 `/policy`、`handleResume` 前 `recheckMandate`
- [x] `src/github-watcher.ts`：评论作者作 `principal`
- [x] `src/proactive.ts`：关键词投递标 `origin=proactive`、真实发信人、`mentioned=false`
- [x] `src/cli.ts` 与各测试：任务字面量补 `mandate: null`
- [x] `tests/policy.test.ts`：归一化与版本、矩阵、档位、越权、放宽、GitHub 主体、降权 `observe`、不追溯、恢复重校验、`/pisa policy`、`off`
- [x] `tests/github-comments.test.ts`：评论作者进入 `mandate`，收紧后按作者拒绝
- [x] `tests/telegram.test.ts`：菜单加入 `policy`
- [x] `README.md`、`docs/usage.md`、`docs/architecture.md`、`pisa.config.example.json`：配置示例、鉴权面、数据流与扩展点、索引
- [x] 验证：`bun test`、`bunx tsc --noEmit`
