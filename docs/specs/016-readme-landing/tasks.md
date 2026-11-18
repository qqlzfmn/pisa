# 016 · 任务

## 文档

- [x] T001 `docs/operations.md`：迁入配置定位、命令、撤销、webhook、CLI、Web 控制台、多仓库、主动发现、定时、保留、GitHub 评论、自举、launchd（FR-009）
      验证：`docs/usage.md`、`CONTRIBUTING.md` 的入口改为指向它；链接测试通过
- [x] T002 重写 `README.md`：定位、三类读者、演示、是什么、30 秒上手、架构图、三个场景、边界、FAQ、限制、文档地图（FR-001/003/004/005/006/007）
      验证：首屏含定位句与读者表；mermaid 渲染无语法错误；场景 1 与 webhook 响应来自实跑
- [x] T003 新增 `LICENSE`（MIT），README 徽章指向它（FR-002）
      验证：license 徽章返回 200

## 演示

- [x] T004 用 `fake-omp` + pty 录制真实 CLI 通道，渲染 `docs/assets/demo.gif`（FR-008）
      验证：`PIL` 读出 16 帧、940×600、循环播放；README 图下注明 stub worker

## 工程

- [x] T005 `tests/docs-links.test.ts`：所有 Markdown 相对链接必须存在，README 锚点必须落在标题上
      验证：删掉 GIF 时测试失败，补齐后通过
- [x] T006 同步 `docs/architecture.md`（环境变量白名单表述、`当前状态` 引用改 `已知限制`）、`CHANGELOG.md`、`CONTRIBUTING.md` 文档地图
      验证：`bun test` 与 `bunx tsc --noEmit` 通过

## 验收

- [x] T007 干净副本上原样执行「30 秒上手」，确认接单、worktree 隔离、`pisa/<任务号>` 分支有提交、main 未被改动
- [x] T008 `bun test`（234 通过）与 `bunx tsc --noEmit`（无报错）
