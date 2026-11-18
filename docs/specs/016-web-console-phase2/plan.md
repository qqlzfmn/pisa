# 016 · 实施计划

## D1 撤销逻辑收敛到 `src/rewind.ts`

Phase 1 之前，web 若想支持撤销，只能再写一套「探测分支/工作副本 → 执行动作 → 决定是否置 rewound」。做法：

- `rewind.ts` 导出 `rewindProbes(runner)`（git / 文件系统 / `gh` 探测的唯一实现）
- `rewind.ts` 导出 `executeRewind(plan, store, deps)`：执行动作、删成功副作用、可判定合并状态时置 `rewound`，返回 `{ results, rewound }`
- `rewind.ts` 导出 `formatRewindOutcome` 与 `MERGE_LABEL`，IM 与 web 输出同一份文案
- `router.ts` 删掉私有 `rewindProbes` 与内联的「执行 + 置状态」段落，改为调用上面两个函数

理由：`planRewind` 本身已是纯逻辑（探测注入），把剩下两段也搬进去，web 与 IM 的命令行为就只能一致，不会各自漂移。

## D2 `Config.configPath` 记录配置文件本身

页面要写回 `pisa.config.json`，而 `loadConfig` 之前只返回解析结果。新增可选 `configPath`（读成功时是绝对路径，未读到缺失），web 用它定位写回目标；缺失时 409 而不是猜路径。

## D3 `src/config-edit.ts`：投影、校验、写回

```
editableConfig(cfg)              → { repos, worker{adapter,command,concurrency,timeoutSec}, schedules }
parseEditable(input)             → { ok: true, config } | { ok: false, errors[] }
saveEditableConfig(path, patch)  → 读原 JSON，只覆盖上述三类字段后原子写
summarizeEditable(config)        → 审计用的单行摘要（不含 prompt 全文）
```

- 校验规则集中在 `parseEditable`，错误信息带 `repos[1].alias` 这类路径，页面直接逐行展示
- cron 复用 `scheduler.parseCron`，不写第二个解析器
- 写回用 `${path}.tmp` + `renameSync`，避免半截文件；`worker` 用展开合并，保住 `extraArgs`、`envAllow` 等表单外的键
- 不做「保存即生效」：运行中的调度与并发槽位不重载，接口返回 `restartRequired`

## D4 `src/metrics.ts` + `Store` 两个只读查询

按天聚合放在 `metrics.ts`（分桶、空日补齐、成功率/平均耗时口径），SQL 放在 `store.ts`（`dayStats(from, to)`、`queueDepthAt(t)`），保持「SQL 只有一份」的既有约定。

- `successRate = succeeded / (succeeded + failed)`，取消不计入分母
- `avgDurationMs` 只算 `succeeded` 且有起止时间的任务
- `queueDepth` = 当天结束时刻已创建、未开始、未结束的任务数；与 `started_at` 区间比较，不依赖状态列

## D5 `src/audit.ts`：追加式审计

`<stateDir>/audit.log` 每行一个 JSON：`{ at, actor, action, target, ok, detail }`。`detail` 过 `log.redact()` 并截断 1000 字符；文件超过 512 KiB 时裁到最近 500 行。

放在文件而不是 SQLite：写操作量级小、能直接 `tail`/`grep`，也不给 `store` 增加写路径。

## D6 `web.ts` 扩展路由与统一确认

新增：

- `GET|POST /api/tasks/<id>/rewind`（预览 / 执行）
- `GET|PUT /api/config`
- `GET /api/metrics?days=`
- `GET /api/audit?limit=`

并把「写操作要求 `confirm: true`」收成 `requireConfirm(req, what)`，派活/取消/合并/撤销/保存配置全部走它。页面所有的写操作都是「浏览器 `confirm()` → 请求带 `confirm: true`」，服务端这一层是兜底。

`WebDeps` 新增可选 `ghRunner`：撤销探测里的 PR 状态需要 `gh`，测试注入假实现。

## D7 页面

`src/web-ui.ts` 仍是一段 HTML 字符串，新增：

- 指标区：三张柱状图用 div 高度百分比实现，悬停显示当天数值，不引图表库
- 配置区：仓库与定时任务表格行可增删，worker 四个字段，保存前 `confirm()` 列出摘要；校验错误逐行显示在提示区；保存成功的提示写明「重启后生效」
- 详情区：已完成任务追加撤销面板（先读预览，再给执行按钮）
- 审计区：最近 20 条，随刷新与写操作更新

## 测试

- `tests/config-edit.test.ts`：校验边界（别名重复/非法、并发 1/32/0/33/小数、超时、cron、未知仓库）、写回保留表单外字段、`loadConfig` 读回、投影字段
- `tests/web.test.ts` 扩展：撤销预览不改磁盘、缺 `confirm` 不执行、执行后副作用与状态与审计；配置 GET/非法 PUT/缺 confirm/合法 PUT 后读回；指标在固定时间下的聚合值；审计条数与内容

验证命令：`bun test`、`bunx tsc --noEmit`；再起真实服务用 curl 走 401 → 指标 → 配置 → 撤销预览。
