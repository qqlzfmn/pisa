# 016 · Web 控制台 Phase 2：撤销预览、配置编辑、指标图表

- 状态：specified / implemented
- 关联：`docs/specs/015-web-console/spec.md`（Phase 1 的鉴权、路由与页面骨架）、`docs/specs/013-rewind/spec.md`（撤销语义）
- 依赖：013 撤销（计划与执行）、011 多仓库（仓库配置）、调度器（cron 解析）

## 1. 问题

Phase 1 解决了「看」与「三个高频操作」，但日常维护仍要回到终端或手改文件：

- 撤销要先记命令 `/pisa rewind <id>`，写完还要判断 YES/NO；计划内容在聊天里滚走，页面看不到会删掉什么
- `pisa.config.json` 的仓库、并发、定时任务只能手改：没有语法与取值校验，改错要等重启后才发现，也没人提醒「重启才生效」
- 成功与失败、耗时、堆积趋势只存在于历史任务表，没有一处能看出「这周是不是更慢了」

## 2. 目标

- 撤销的计划与执行都在任务详情里完成，执行前列出将执行的动作与不可撤销项
- 仓库、worker 的并发/超时/命令、定时任务在页面上可视化编辑；保存前本地读回校验，保存后明确提示重启生效
- 成功率、平均耗时、队列深度按天成图，14 天窗口
- 所有写操作二次确认，并且落到一份人和机器都能读的审计日志

## 3. 用户故事

### US-1 撤销前看清代价

作为所有者，我打开一条已完成任务的详情，看到「合并状态 + 将执行的动作列表 + 不可撤销项」，确认后才执行；执行结果逐个动作列出成功/失败。

### US-2 页面改配置

作为所有者，我在页面上增删仓库、改并发与超时、增删停用定时任务，点保存；非法值立刻被指出具体字段，文件不会被写坏。

### US-3 看趋势

作为所有者，我打开页面顶部即可看到最近 14 天的成功率、平均耗时、队列深度柱子，鼠标悬停能看到具体数值。

### US-4 追责与回溯

作为所有者，我在审计表里看到每次派活、取消、合并、撤销、保存配置的时间、对象与结果。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-016 | `GET /api/tasks/<id>/rewind` 只读返回撤销计划：`merge`、`mergeLabel`、`actions`（动作文案数组）、`irreversible`、`notes`；不存在 404；已撤销、未结束、仓库未配置 409 |
| FR-017 | `POST /api/tasks/<id>/rewind` 必须带 `confirm: true`；执行后删成功的副作用、可判定时置 `rewound`；返回 `{ ok, rewound, status, actions, results, message }`，`ok` 表示是否完成撤销 |
| FR-018 | 撤销探测与执行逻辑只有一份：`src/rewind.ts` 提供 `rewindProbes`、`executeRewind`、`formatRewindOutcome`，web 与 IM 命令共用 |
| FR-019 | `GET /api/config` 返回 `{ path, config }`；`config` 只含表单字段：`repos`（alias/path/remote/baseBranch）、`worker`（adapter/command/concurrency/timeoutSec）、`schedules`；每次读盘，反映文件当前内容；启动时没读到文件、或文件无法解析返回 409 |
| FR-020 | `PUT /api/config` 必须带 `confirm: true`，请求体 `config` 必须是完整的表单值；校验失败返回 400 与逐条中文错误，文件不改动；成功只覆盖上面三类字段，其它顶层字段与 `worker` 的其它键原样保留；写入用临时文件 + rename；响应带 `restartRequired: true` 与提示 |
| FR-021 | 配置校验规则：仓库至少一个、别名唯一且只含 `A-Za-z0-9_-`、路径非空；`concurrency` 为 1..32 的整数，`timeoutSec` 为 1..86400 的整数；`adapter`、`command` 非空；定时任务 id 唯一非空、cron 合法（复用调度器解析）、prompt 非空、`repo` 必须是已配置别名 |
| FR-022 | `GET /api/metrics?days=<n>` 返回按本地自然日升序的 `{ date, total, succeeded, failed, cancelled, successRate, avgDurationMs, queueDepth }`；默认 14 天，最大按 90 天截断；`successRate` 只在有成功或失败时非空，`avgDurationMs` 只算成功且有起止时间的任务 |
| FR-023 | `queueDepth` 取当天结束时刻仍在排队（已创建、未开始、未结束）的任务数，与「运行中时段」不重叠 |
| FR-024 | `GET /api/audit?limit=<n>` 返回最新在前的审计条目 `{ at, actor, action, target, ok, detail }`，最多 100 条；审计写在 `<stateDir>/audit.log`，每行一个 JSON，`detail` 脱敏并截断，文件超过 512 KiB 时保留最近 500 行 |
| FR-025 | 所有写操作（派活、取消、合并、撤销、保存配置）都要求 `confirm: true`，且无论成功失败都写一条审计；审计失败不影响接口结果 |
| FR-026 | 页面：指标三图（成功率、平均耗时、队列深度）；配置编辑器（仓库与定时任务增删行、worker 四个字段、保存按钮、重启生效提示与错误清单）；详情内的撤销预览与执行按钮；审计表 |
| FR-027 | 页面的每个写操作都在浏览器弹确认框，确认后的请求带 `confirm: true`；配置保存的确认框列出仓库、并发、定时任务摘要 |

## 5. 验收

1. `GET /api/tasks/<id>/rewind`（已完成任务）→ 200，列出动作；磁盘上的工作副本仍在；`POST` 不带 `confirm` → 400；带 `confirm: true` → 工作副本被删除、`task_effects` 对应行消失、任务变为 `rewound`
2. `GET /api/config` 返回文件绝对路径与表单字段；`PUT` 非法 `concurrency: 0` 与坏 cron → 400，错误含字段名，文件字节不变
3. `PUT` 合法值 → 200、`restartRequired: true`；文件只改动表单字段，`retentionDays`、`trigger`、`worker.envAllow` 等保持原值；再次 `GET` 能读回新值
4. `GET /api/metrics?days=1` 在固定时间下返回当天 `total/succeeded/failed/successRate/avgDurationMs/queueDepth` 的预期值；窗口外的旧任务不计入
5. 派活、取消、撤销、保存配置后 `GET /api/audit` 最新一条对应动作；保存失败也留一条 `ok: false`
6. 页面打开后能看到三张图、配置表单与审计表；详情面板有撤销区
7. `bun test` 与 `bunx tsc --noEmit` 通过

## 6. 非目标

- 在线重载配置（保存后仍需重启；不引入热更新）
- 编辑 `pisa.config.json` 之外的字段（whitelist、channels、github、stateDir 等）
- 审计的删除、按条件检索、导出（只提供最近 N 条）
- 指标的自定义时间范围、按仓库分组、持久化聚合表
- 撤销的执行前 diff 预览（动作列表足够判断代价）
