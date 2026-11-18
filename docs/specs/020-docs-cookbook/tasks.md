# 020 文档手册 · 任务

每步的验证点已执行；结果见下。

| # | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| 1 | 复现问题：`docs/` 缺少术语表、部署排障、扩展指南，跨页无互链 | 三条 `ls`/`grep` 均无命中 | 完成 |
| 2 | 写 `docs/domain.md`：状态、触发、执行、交付、运维五组术语 + 易混词 | 7 个状态与 5 个阶段在文档中逐字出现 | 完成（`tests/docs-cookbook.test.ts` 覆盖） |
| 3 | 写 `docs/deployment.md`：安装、运行、环境变量、升级回滚、退出码、排障、日志、备份 | 退出码表与 `src/cli.ts` 的 `EXIT` 常量一致；含 75 | 完成（测试断言表头集合） |
| 4 | 写 `docs/extending.md`：加事件来源、常驻来源、Worker 适配器、同步清单 | 适配器清单与 `REGISTRY` 一致；触发路由与 `src/triggers/http.ts` 一致 | 完成（测试逐项比对） |
| 5 | 互链：README 文档地图、architecture 双向、operations 指向部署与扩展 | `tests/docs-links.test.ts` 通过 | 完成 |
| 6 | 新增 `tests/docs-cookbook.test.ts`：存在性、互链、退出码、适配器、路由、术语、命令块可复制 | 6 个用例通过 | 完成 |
| 7 | 冒烟：按文档命令在临时目录建配置、启动守护进程、调 `/health` 与 CLI 退出码 | ready 行、`/health` 200、exit 2/3/75 与文档一致 | 完成；发现守护进程不认 `--config`，已写进文档 |

回归：`bun test` 全量通过，`bunx tsc --noEmit` 无错误。
