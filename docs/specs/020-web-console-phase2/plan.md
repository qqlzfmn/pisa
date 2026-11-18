# 020 · 实施计划

## D1 撤销预览复用 Router 的计划函数

`Router` 新增公开 `previewRewind(id)`，返回计划或 `{code: "not-found" | "conflict"}`；`handleRewind` 内部改为调用它，聊天与页面共用同一套前置判断（终态、仓库配置、已撤销/排队/运行/暂停）。

`merge` 的中文标签从 `rewind.ts` 的私有映射导出为 `mergeStateLabel`，避免页面再抄一份状态文案。

理由：预览和执行必须是同一份计划；多一条判定路径就会漂移。

## D2 配置编辑独立成模块

`src/config-edit.ts`：

- `editableConfig(cfg)` 把 `Config` 投影成页面视图
- `validateEditable(raw, baseDir, adapters)` 返回 `{ok, value}` 或 `{ok: false, errors}`
- `saveEditableConfig(path, value)` 读现有文件、只覆盖被编辑的顶层键、写临时文件后 `rename`

`Config` 增加运行时字段 `configPath`（`loadConfig` 填入），web 用它定位文件，不再猜路径。

`whitelist.repos` 由提交的 repos 中「允许派活」重建；其余键原样保留。校验不通过不落盘。

理由：校验是纯函数，能直接在测试里喂非法输入；保存保留未知键，避免把 `delivery`、`notifications` 等页面未暴露的配置写丢。

## D3 趋势由纯函数从任务表推导

`src/metrics.ts` 新增 `buildStatsSeries(tasks, from, to, bucketMs, queueStepMs)`：完成量/成功率/耗时按桶调用现有 `computeWindowMetrics`；队列深度按创建时间排序后，用 `createdAt <= at < startedAt/endedAt` 判定。`store.tasksInWindow(from, to)` 只取与窗口有交集的任务。

理由：指标口径与 `/health`、`/pisa status` 共用同一个聚合函数；队列深度不需要额外快照表。

## D4 审计独立成 `src/audit.ts`

`AuditLog.record` 追加 JSONL，`tail(limit)` 读尾部并跳过坏行；`detail` 经 `log.redact` 后截 500 字；超过 5 MiB 轮转。写入失败只告警，不影响主操作。

web 层的 `recordAudit(action, target, ok, detail)` 统一提供操作者与时间。

理由：审计是横切关注点，放 web 路由里会让每个分支重复三行，且无法单独测试。

## D5 二次确认在 HTTP 入口统一强制

新增 `confirmedBody(req)`：读 JSON，`confirm !== true` 直接 400。所有写路由先调用它，再进入业务分支。

理由：之前只有合并校验 `confirm`，派活/取消/撤销/保存配置各写一遍容易漏；放在入口一次覆盖。代价是派活/取消的既有测试要补 `confirm: true`。

## D6 页面只加区块，不引入框架

`src/web-ui.ts` 仍是单文件内联 HTML：配置用 `details` + 表单行，审计用表格，撤销预览用详情面板内的区块；图表用现成的 div 柱与 SVG `polyline`，不引图表库。

所有文本仍用 `textContent` 构造；配置值来自用户输入，禁止 `innerHTML`。

## 测试

- `tests/config-edit.test.ts`：白名单映射、聚合校验错误、保存保留未知键、拒绝覆盖非对象文件
- `tests/audit.test.ts`：追加/limit、脱敏与截断、坏行跳过
- `tests/metrics.test.ts`：日桶边界、队列采样
- `tests/web.test.ts`：缺 `confirm` 400、撤销预览/执行、`/api/stats`、`/api/config` 校验与保存、`/api/audit`

验证命令：`bun test`、`bunx tsc --noEmit`；再起真实服务走一遍 `/ui` 与上述接口。
