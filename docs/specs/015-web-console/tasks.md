# 015 · 任务清单

## 契约与数据

- [ ] T001 `Config.web` 与默认值，`merge` 浅合并 (FR-001)
      验证：`bunx tsc --noEmit`
- [ ] T002 `IncomingMessage.admin`，Router 的防护与请求者校验放行 (FR-015)
      验证：`bun test tests/router.test.ts`
- [ ] T003 `status.taskJson` 共享化，`cli.ts` 删本地副本 (FR-006)
      验证：`bun test tests/cli.test.ts`
- [ ] T004 `log.readTail` / `log.tailLines` 共享化 (FR-007)
      验证：`bun test tests/cli.test.ts`

## 服务

- [ ] T005 `ReplyBus`：请求期收集回执，其余 chatId 转发下游 (FR-008)
      验证：`bun test tests/web.test.ts`
- [ ] T006 `createWebApp` 鉴权与路由骨架，401 与 `/ui` cookie (FR-002~004)
      验证：`curl -s -o /dev/null -w '%{http_code}' :8787/ui` → 401
- [ ] T007 `GET /api/tasks` 与 `GET /api/tasks/:id` (FR-005~007)
      验证：`bun test tests/web.test.ts`
- [ ] T008 `POST /api/tasks`、`/cancel`、`/merge` (FR-008~010)
      验证：`bun test tests/web.test.ts`

## 页面

- [ ] T009 `src/web-ui.ts` 单页：三组表格、仓库筛选、详情、复制、确认框、自动刷新 (FR-011~014)
      验证：浏览器打开 `/ui`，派活 → 看板出现 → 详情有日志

## 集成

- [ ] T010 `index.ts` 装配 Web 服务与关停，`package.json` 增加 `web` 脚本 (FR-001)
      验证：`bun run web` 打印地址，浏览器可用
- [ ] T011 文档：README「Web 控制台」、配置示例、architecture 模块表与入口说明
      验证：`bun test tests/architecture-doc.test.ts`

## 验收

- [ ] T012 走完 `spec.md` 第 5 节 8 条
      验证：`bun test`、`bunx tsc --noEmit`
