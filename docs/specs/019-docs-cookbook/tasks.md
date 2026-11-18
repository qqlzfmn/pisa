# 019 · 任务

## 文档

- [x] T001 新增 `docs/domain.md`：四组术语，每词给定义、代码位置与易混点（FR-001）
      验证：每个 `src/...` 引用存在；与 architecture 互链
- [x] T002 新增 `docs/deployment.md`：前置、安装、启动自检、launchd、升级、回滚、排障、退出码、自检清单（FR-002/003/004）
      验证：退出码表与 `EXIT` 相等；launchd 标签与脚本一致；命令块 `bash -n` 通过
- [x] T003 新增 `docs/extending.md`：加事件源与加 WorkerAdapter 的步骤、代码、测试与验证命令（FR-005/006）
      验证：接口代码块与 `src/adapters/types.ts` 成员一致；路径存在；命令可执行

## 互链

- [x] T004 更新 `docs/architecture.md`：引言链 domain，4.1/4.2 链 extending，5.1 链 deployment，索引表加三行（FR-007）
      验证：锚点测试通过
- [x] T005 更新 README、CONTRIBUTING 文档地图；operations 的安装/launchd/退出码改为指向 deployment；usage 的卡住排查链 deployment（FR-007）
      验证：全仓相对链接与锚点测试通过；operations 不再重复 launchd 安装细节

## 工程

- [x] T006 `src/cli.ts` 导出 `EXIT`，供文档一致性测试使用
      验证：`bunx tsc --noEmit` 无报错
- [x] T007 新增 `tests/docs-cookbook.test.ts`：退出码、接口、路径、互链、launchd 标签（FR-008）
      验证：临时改错文档对应行时测试失败，恢复后通过
- [x] T008 扩展 `tests/docs-links.test.ts`：全仓 Markdown 的跨文件锚点（FR-008）
      验证：把任一 `#退出码` 改成 `#不存在` 时测试失败
- [x] T009 更新 `CHANGELOG.md` 的 `Unreleased`
      验证：条目指向三份文档与测试

## 验收

- [x] T010 所有新增命令块用 `bash -n` 校验；可离线执行的命令实际跑一遍
      验证：`bun run src/cli.ts --help`、`bun test tests/docs-cookbook.test.ts tests/docs-links.test.ts`
- [x] T011 `bun test` 全量通过；`bunx tsc --noEmit` 无报错
      验证：测试输出与基线（301 通过）对比，只多不少
