# 017 · 任务

- [x] `src/policy.ts`：类型、默认值、`sourcePolicy`、`admit`、`policyVersion`、`mandateOf`、`formatPolicy`
- [x] `src/types.ts`：`Task.mandate`、`IncomingMessage.addressed`
- [x] `src/config.ts`：`Config.policy`、`policy` 命令与 `CommandKind`
- [x] `src/store.ts`：`mandate` 列、行映射、迁移、插入
- [x] `src/router.ts`：准入接入、`checkRepo`、`isAddressed`、mandate 落库、resume 重校验、`policy` 命令与私聊入口
- [x] `src/proactive.ts`：关键词派活标记未点名
- [x] `src/cli.ts`：CLI 直接建单 `mandate=null`
- [x] 测试夹具补齐 `mandate`：`router` / `web` / `rewind` / `retention` / `worker` / `adapter` / `cli` / `github-comments`
- [x] `tests/policy.test.ts`：默认、覆盖、模式、版本、展示
- [x] `tests/router.test.ts`：越权、未点名放行、off、observe、不追溯、降权恢复被拒、仓库移出后恢复被拒、`policy` 命令
- [x] `tests/telegram.test.ts`：命令菜单包含 `policy`
- [x] 文档：`docs/usage.md` 鉴权面、`docs/architecture.md` 模块表与数据流、`docs/operations.md` 命令表、`pisa.config.example.json`
- [x] 验证：`bun test`、`bunx tsc --noEmit`
