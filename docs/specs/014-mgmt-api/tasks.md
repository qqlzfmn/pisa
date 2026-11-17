# 014 · 任务清单

- [x] T001 `src/board.ts`：抽出 `formatDuration`、`snapshot`、`formatBoard`（FR-003, FR-012）
      验证：`bun test tests/router.test.ts`
- [x] T002 `Store.requeue`（FR-006）
      验证：`bun test tests/mgmt.test.ts`
- [x] T003 Router：暂停开关 + `submitTicket` / `stopTicket` / `retryTicket` / `mergeTicket` / `rewindTicket`，IM 处理器改为调用共用实现（FR-006, FR-007, FR-008, FR-010, FR-011）
      验证：`bun test tests/router.test.ts tests/rewind.test.ts tests/github-comments.test.ts`
- [x] T004 `readTaskLog`（FR-009）
      验证：`bun test tests/mgmt.test.ts`
- [x] T005 `src/mgmt.ts`：回环校验、token 鉴权、全部路由（FR-001 ~ FR-011）
      验证：`bun test tests/mgmt.test.ts`
- [x] T006 `src/cli.ts` + `src/pisa.ts`：五个子命令与退出码（FR-012, FR-013, FR-014）
      验证：`bun test tests/cli.test.ts`
- [x] T007 配置 `mgmt` + `index.ts` 启动与关停（FR-015）
      验证：`bunx tsc --noEmit`
- [x] T008 README、`pisa.config.example.json`、`package.json` bin/scripts 同步
      验证：人工核对文档命令与实际参数一致
- [x] T009 全量验证
      验证：`bun test` 与 `bunx tsc --noEmit` 通过
