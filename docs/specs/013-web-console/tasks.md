# 013 · 任务

- [x] `src/types.ts`：`IncomingMessage.admin`
- [x] `src/store.ts`：`runningTasks` / `queuedTasks` / `recentFinished` / `countByStatus` 支持仓库过滤，新增 `taskBySource`
- [x] `src/log.ts`：`readLogTail` 有界读取并结构化
- [x] `src/router.ts`：`cancelTask` / `mergeTask` 返回 `CommandOutcome`，`admin` 跳过请求者校验
- [x] `src/worker.ts`：Worker 以独立进程组启动，取消/超时按组终止
- [x] `src/web.ts` + `src/ui.html`：鉴权、看板、详情、派活、取消、合并、单页控制台
- [x] `src/index.ts`：`--web` 启动方式、内置 web、关停时停止服务
- [x] `src/config.ts` + `pisa.config.example.json` + `package.json`：`web` 配置、`bun run web`
- [x] `tests/web.test.ts`：鉴权、路由、三个写操作
- [x] `tests/worker.test.ts`：取消能终止占着管道的子进程
- [x] `README.md`：Web 控制台一节
- [x] 验证：`bun test`（142 通过）、`bunx tsc --noEmit`、真实启动 curl（鉴权/派活/取消/合并）
