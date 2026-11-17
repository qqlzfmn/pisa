# 014 · 设计

## 1. 决策

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 白名单位置 | `github.allowedUsers`，全局一份 | 评论作者是 GitHub 身份，与仓库条目无关；按仓库分别配会增加漏配面（FR-001） |
| 未配置时 | 不轮询、不投递，仅启动日志提示 | 公开仓库默认安全；宁可派活停用也不默认放行（FR-002） |
| 作者过滤位置 | `GithubWatcher.pollRepo`，触发词判断之后、解析 PR 号之前 | 不触发类型判定等额外 `gh` 调用；已建任务的评论不再重复告警（FR-003） |
| 身份字段 | `userId` 保留配置值，新增 `IncomingMessage.author` → `tasks.author` | 回帖路由依赖配置身份；鉴权与归属拆成两个字段，各用各的（FR-004） |
| 通道收窄位置 | `Router.handle` 解析出命令后、任何分发与落库之前 | 一处门禁覆盖全部命令分支；`merge` 等分支根本进不去（FR-005/FR-006） |
| 收窄方式 | 关键词集合 `TASK_ONLY_CHANNELS` + 白名单命令 `task` / `continue` | 新增特权命令默认被拒，不需要逐个登记 |

## 2. 影响面

- `src/config.ts`：`GithubConfig.allowedUsers`
- `src/github-watcher.ts`：作者集合、启动 fail-closed、逐条过滤与告警、投递带 `author`
- `src/types.ts`：`IncomingMessage.author`、`Task.author`
- `src/store.ts`：`tasks.author` 列与轻量迁移、`insertTask` 写入
- `src/router.ts`：`TASK_ONLY_CHANNELS` 门禁、建任务写 `author`
- `pisa.config.example.json`、`README.md`、`docs/specs/006-github-comments`

## 3. 测试策略

- `tests/github-comments.test.ts`：非白名单作者不派活且只告警一次；白名单作者大小写不敏感、`requester` 仍为配置值、`author` 保留原 login；`allowedUsers` 为空时 `start()` 不发任何 `gh` 调用并打印 fail-closed 日志
- `tests/router.test.ts`：`github` 通道 `merge` 被拒且主干 sha 不变；`webhook` / `cron` / `proactive` 的 `cancel` / `resume` 被拒且任务状态不变
- 既有用例全部使用白名单内作者，行为不变

## 4. 风险

- 升级后未配 `allowedUsers` 时评论派活静默停用：启动日志有明确提示，README 与示例配置同步说明
- 非 IM 通道里发单个英文词（如评论 `/pisa refactor`）会收到确认提示，但 `confirm` 只对 IM 开放，无法确认；改发中文或多词正文即可。这是「只放行 task 与 continue」的直接后果，需要时可在 `TASK_ONLY_CHANNELS` 门禁里把 `confirm` 一并放行
- 白名单只认 login：GitHub 账号改名后需同步配置；这是刻意的最小模型（spec 非目标）
- `author` 列是审计字段，不参与任何查询：不建索引
