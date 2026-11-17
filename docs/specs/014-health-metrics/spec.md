# 014 · 健康检查与任务指标（/health）

- 状态：implemented
- 关联：改进项 `seed:health-metrics`；010 任务看板只看当前快照，没有任何趋势数据
- 依赖：无

## 1. 问题

现在只有日志和 `/pisa status`：

1. 外部监控无法探测进程是否健康——没有 HTTP 探活接口，只能看端口或日志。
2. `/pisa status` 只给出当前在跑、排队、最近 5 条完成记录，看不到最近一天的成功率与耗时分布，出问题只能翻日志、凭印象判断。
3. 多仓库运行时，看不出负载落在哪个仓库。

## 2. 目标

- 一个只读 HTTP 接口 `GET /health` 返回可直接采集的 JSON：健康标志、运行时长、队列深度、运行中数量、每仓库任务数、最近 24 小时的成功率与耗时分位。
- `/pisa status` 在汇总行后追加最近 24 小时汇总，人不用另开接口也能判断趋势。
- 聚合计算独立成纯函数，可单测；不引入任何外部依赖。

## 3. 用户故事

### US-1 外部监控探活

作为监控系统，我定时 `GET /health`，拿到 200 与 `ok: true` 就认为进程可用；拿到 5xx 或连接失败就告警。

### US-2 看负载分布

作为维护者，我从 `/health` 的 `repos` 字段看到每个仓库当前运行中与排队的任务数，判断是否某个仓库把并发槽位占满。

### US-3 看最近一天的趋势

作为维护者，我看 `/health` 的 `last24h` 与 `/pisa status` 的末行，知道最近 24 小时完成了多少、成功率多少、P50/P95 耗时多少。

## 4. 需求

| ID | 需求 |
| --- | --- |
| FR-001 | 提供 `GET /health`，返回 `application/json`；其它方法返回 405；不需要鉴权，只监听回环地址 |
| FR-002 | 响应字段：`ok`、`uptimeSec`、`running`、`queueDepth`、`repos`、`last24h` |
| FR-003 | `ok` 在成功读取存储时为 `true`；读取失败时响应 503 且 `ok: false`，附 `error` 字符串 |
| FR-004 | `uptimeSec` 为进程已运行秒数（向下取整） |
| FR-005 | `running` 为当前 `running` 状态任务数；`queueDepth` 为当前 `queued` 状态任务数 |
| FR-006 | `repos` 为数组，每项 `{ repo, running, queued, finished24h }`：该仓库当前运行中、排队、最近 24 小时完成的任务数；只含至少有一项非零计数的仓库，按仓库名升序 |
| FR-007 | `last24h` 统计窗口为「结束时间落在最近 24 小时内」的终态任务，字段 `total`、`succeeded`、`failed`、`cancelled`、`successRate`、`p50Ms`、`p95Ms` |
| FR-008 | `total` 为窗口内全部终态任务数（含取消/撤销）；`succeeded`、`failed`、`cancelled` 分别为对应状态数（撤销并入 `cancelled`） |
| FR-009 | `successRate = succeeded / (succeeded + failed)`，保留 3 位小数；分母为 0 时为 `null`；取消与撤销不计入分母 |
| FR-010 | 耗时分位取「结束时间 − 开始时间」，只统计窗口内 `startedAt` 与 `endedAt` 都存在的任务；`p50Ms`、`p95Ms` 为最近秩（nearest-rank）整数毫秒，样本为空时为 `null` |
| FR-011 | `/pisa status` 在原有汇总行后追加一行：`近 24h：完成 <total> · 成功率 <百分比> · P50 <时长> · P95 <时长>`；成功率保留 1 位小数；无样本的分位显示 `-`；窗口内无终态任务时输出 `近 24h：(无完成)` |
| FR-012 | 时长格式复用 `formatDuration`（`42s` / `3m12s` / `2h5m`） |
| FR-013 | 健康接口默认启用，监听 `127.0.0.1:8798`；配置 `health.enabled` 与 `health.port` 可覆盖；端口占用只写告警日志，不影响进程启动 |
| FR-014 | 聚合不使用外部依赖，按请求实时查询 SQLite，不维护额外缓存或指标文件 |

## 5. 验收

1. 空库：`GET /health` 返回 200，`ok=true`，`running=0`，`queueDepth=0`，`repos=[]`，`last24h.successRate=null`，`p50Ms=null`，`p95Ms=null`
2. 3 个已完成任务（2 成功 1 失败，耗时 10s/20s/60s）：`total=3`，`successRate=0.667`，`p50Ms=20000`，`p95Ms=60000`
3. 一个 25 小时前结束的任务不计入 `last24h`
4. 一个取消任务计入 `total` 与 `cancelled`，不改变 `successRate`
5. 两个仓库各有一条排队任务时，`repos` 两个条目各 `queued=1`，按仓库名升序
6. `/pisa status` 输出包含 `近 24h：完成 3 · 成功率 66.7% · P50 20s · P95 1m0s`
7. `GET /health` 用 POST 请求返回 405
8. `bun test` 与 `tsc --noEmit` 通过

## 6. 非目标

- 指标持久化、Prometheus 文本格式、历史曲线
- 鉴权、远程监听、TLS
- 按请求者或任务来源拆分指标
- 实时推送（仍是拉取式）
