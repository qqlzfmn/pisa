# 019 · 任务清单

- [x] T1 `src/http.ts`：`HttpError` 带 `reason`，`json()` 助手迁移过来
- [x] T2 `src/channels/reply-bus.ts`：抽出 `ReplyBus`，构造函数增加本机会话列表
- [x] T3 `src/router.ts`：`pause/resume/isPaused` + `fill()` 早退；`retry` 命令与 `handleRetry`；admin 入口跳过用户白名单与别名路由、裸正文直接建任务；`status` 回执带暂停提示
- [x] T4 `src/status.ts`：`formatStatusBoard(store, now, {paused})`；`STATUS_LABEL` 与 `taskJson.statusLabel` 收口到状态投影
- [x] T5 `src/config.ts`：`COMMANDS` 增加 `retry`
- [x] T6 `src/api.ts`：`/api/state`、`/api/board`、`/api/tasks`（列表/投递/详情/日志）、六个动作、`/api/executor/pause`
- [x] T7 `src/web.ts`：`/api/*` 走请求头鉴权后委托 `api.ts`；`/ui` 受 `web.enabled` 控制
- [x] T8 `src/index.ts`：控制面常驻、`ReplyBus` 本机会话、启动告警
- [x] T9 `src/cli.ts`：改造成 HTTP 客户端，新命令与退出码；`run`/`stop` 别名
- [x] T10 `src/web-ui.ts`：看板改拉 `/api/board`
- [x] T11 测试：`tests/api.test.ts` 新增（鉴权、越权、各动作与状态判定）、`tests/cli.test.ts` 重写为端到端（真实 `Bun.serve` + 四类退出码）、`tests/web.test.ts` 精简为外壳（页面开关、`/health`、405/404）、`tests/telegram.test.ts` 菜单补 `retry`
- [x] T12 文档：本目录三件套，014/015/018 规格、usage/operations/architecture/README/skills/CHANGELOG
