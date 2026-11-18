# 022 任务

- [x] T001 写术语表 `docs/domain.md`，按任务、入口、执行、运维分组并给代码落点
  - 验证：术语覆盖 `Task`、`status`、`Trigger`、`Source`、`TriggerAdapter`、`WorkerAdapter`、`Deliverer`、`Effect`、`reconcile`、`rewind`
- [x] T002 写部署与排障 `docs/deployment.md`，覆盖安装、升级、回滚、退出码、数据目录与排障表
  - 验证：CLI 退出码表与 `src/cli.ts` 的 `EXIT` 常量一致
- [x] T003 写扩展指南 `docs/extending.md`，覆盖协议型 Source、常驻型 Source、WorkerAdapter 的实现、接线与测试
  - 验证：三类扩展都有文件落点、接口、配置、测试文件与运行命令
- [x] T004 在 `architecture.md`、README、CONTRIBUTING 与 operations 建立互链，operations 去重
  - 验证：`tests/docs-links.test.ts` 无坏链，`architecture.md` 与三份文档双向可达
- [x] T005 新增 `tests/docs-cookbook.test.ts`
  - 验证：`bun test tests/docs-cookbook.test.ts` 通过
- [x] T006 跑全量测试与类型检查
  - 验证：`bun test`、`bunx tsc --noEmit` 通过
