# 018 · 任务

## 先红

- [x] T001 `tests/docs-cookbook.test.ts`：退出码表、适配器清单、术语代码路径、互链、`bash -n`（FR-005/007/008/009/011）
      验证：三篇文档未落地时测试失败，失败原因是文件不存在

## 文档

- [x] T002 `docs/domain.md`：四组术语表，每条带代码位置与关联文档（FR-001/002）
      验证：`tests/docs-cookbook.test.ts` 的路径与链接断言通过
- [x] T003 `docs/deployment.md`：前置条件、安装、升级、回滚边界、卸载、常驻（迁自 `operations.md`）、排障表、退出码（FR-003/004/005/010）
      验证：`operations.md` 不再有 launchd 命令；`bash -n` 通过
- [x] T004 `docs/extending.md`：加 Source 与加 Adapter 的步骤、测试用例、验证命令；适配器清单表（FR-006/007/008）
      验证：清单与 `ADAPTERS` 一致
- [x] T005 互链：`architecture.md` 顶部配套文档行 + §4 指向 extending；README 与 CONTRIBUTING 文档地图各加三行（FR-009）
      验证：`docs-links.test.ts` 与 `docs-cookbook.test.ts` 同时通过

## 代码

- [x] T006 导出 `EXIT`（`src/cli.ts`）与 `ADAPTERS`（`src/adapters/index.ts`），`getAdapter` 的错误信息复用 `ADAPTERS`
      验证：`bunx tsc --noEmit`
- [x] T007 `CHANGELOG.md` 的 `Unreleased` 记录三篇文档与测试
      验证：人工核对

## 验收

- [x] T008 `bun test`、`bunx tsc --noEmit`
      验证：280 个测试全通过；TypeScript no errors
- [x] T009 按 `deployment.md` 的命令在临时目录起一次 `[pisa] ready`，确认安装与启动步骤可复制
      验证：临时副本里 `bun install --ignore-scripts` → `cp pisa.config.example.json pisa.config.json` → `bun run src/index.ts --channel cli` 打出 `[pisa] ready · channel=cli · repos=pisa · concurrency=2`；`sqlite3 .pisa/pisa.db ".backup ..."`、`bun run src/cli.ts status`、缺 token / 无通道的退出码 1 均实测
